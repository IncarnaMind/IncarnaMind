import { existsSync } from "node:fs";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import type { ModelSourceChoice } from "../../src/core";
import { silentLogger } from "../../src/core/activityLog";
import { BUILT_IN_EMBEDDING_MODEL } from "../../src/core/embedding";
import { downloadModel, ModelDownloadError } from "../../src/core/embedding/download";
import {
  createModelSources,
  type ModelCopies,
  PROBE_KEPT_MS,
} from "../../src/core/embedding/modelSources";
import type { Language } from "../../src/core/language";
import {
  createSpeakerModel,
  SPEAKER_EMBEDDING,
  SPEAKER_SEGMENTATION,
} from "../../src/core/transcription/speakerModel";
import { createTempDataFolder, LOCAL_FETCH, startCore } from "../helpers/core";
import {
  createControlledEmbedder,
  type ModelServer,
  startModelServer,
  turnOnEmbeddings,
  waitForModel,
} from "../helpers/embedding";

const FOLDER = "multilingual-e5-small";
const PINNED = "https://huggingface.co/intfloat/multilingual-e5-small/resolve/abc123/";
const FILE = { path: "onnx/model.onnx", size: 10, sha256: "0".repeat(64) };
const COPIES: ModelCopies = {
  modelscope: { url: "https://www.modelscope.cn/models/IncarnaMind/{folder}/resolve/master/" },
  r2: { url: "https://models.example.com/{folder}/", hosts: ["cdn.example.net"] },
};

function probing(answers: { huggingface: boolean; modelscope: boolean; hfMirror?: boolean }) {
  const asked: string[] = [];
  const fetcher: typeof fetch = (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    asked.push(url.host);
    const answered =
      (url.host === "huggingface.co" && answers.huggingface) ||
      (url.host === "www.modelscope.cn" && answers.modelscope) ||
      (url.host === "hf-mirror.com" && answers.hfMirror === true);
    return answered
      ? Promise.resolve(new Response(null, { status: 200 }))
      : Promise.reject(new TypeError(`${url.host} can't be reached`));
  };
  return { fetcher, asked };
}

function sourcesWith(
  fetcher: typeof fetch,
  {
    copies = COPIES,
    language = "en",
    choice = "auto",
    clock = { now: 0 },
    proxy = { value: "DIRECT" },
    stallMs,
  }: {
    copies?: ModelCopies;
    language?: Language;
    choice?: ModelSourceChoice;
    clock?: { now: number };
    proxy?: { value: string };
    stallMs?: number;
  } = {},
) {
  return createModelSources({
    fetch: fetcher,
    now: () => clock.now,
    language: () => language,
    choice: () => choice,
    proxy: async () => proxy.value,
    copies,
    ...(stallMs !== undefined && { stallMs }),
  });
}

const order = async (sources: ReturnType<typeof sourcesWith>) =>
  (await sources.urlsFor(FOLDER, FILE, PINNED)).map((each) => each.source);

describe("Where a built-in model's files come from (#1578)", () => {
  // protects=outside mainland China Hugging Face leads, then IncarnaMind's copy on ModelScope, hf-mirror.com and IncarnaMind's copy on R2, each at the pinned file's own path; fails_when=the order differs, a URL leaves the pinned revision or path, or a copy's URL misses its folder; no_claim=whether the hosts serve the files, which the download tests cover.
  test("Hugging Face leads when it answers first, then the copies and the mirror in turn", async () => {
    const { fetcher } = probing({ huggingface: true, modelscope: false });
    const urls = await sourcesWith(fetcher).urlsFor(FOLDER, FILE, PINNED);
    expect(urls.map(({ source, url }) => [source, url.href])).toEqual([
      ["huggingface", `${PINNED}onnx/model.onnx`],
      [
        "modelscope",
        "https://www.modelscope.cn/models/IncarnaMind/multilingual-e5-small/resolve/master/onnx/model.onnx",
      ],
      [
        "hf-mirror",
        "https://hf-mirror.com/intfloat/multilingual-e5-small/resolve/abc123/onnx/model.onnx",
      ],
      ["r2", "https://models.example.com/multilingual-e5-small/onnx/model.onnx"],
    ]);
  });

  // protects=when ModelScope answers the probe first (mainland China), it leads, and hf-mirror comes before Hugging Face; fails_when=Hugging Face still leads, so every file waits on a blocked host first; no_claim=the probe's timing on a real network.
  test("ModelScope leads when it answers first, and the mirror comes before Hugging Face", async () => {
    const { fetcher } = probing({ huggingface: false, modelscope: true });
    expect(await order(sourcesWith(fetcher))).toEqual([
      "modelscope",
      "hf-mirror",
      "huggingface",
      "r2",
    ]);
  });

  // protects=when neither host answers the probe, the interface language is the tie-break: Chinese takes mainland China's order; fails_when=a failed probe always picks one order, or the language decides when a probe answered; no_claim=which order is right for a User abroad who reads Chinese, which only the probe can tell.
  test("when neither answers, the interface language decides", async () => {
    const { fetcher } = probing({ huggingface: false, modelscope: false });
    expect((await order(sourcesWith(fetcher, { language: "zh-CN" })))[0]).toBe("modelscope");
    expect((await order(sourcesWith(fetcher, { language: "en" })))[0]).toBe("huggingface");
    const answered = probing({ huggingface: true, modelscope: false });
    expect((await order(sourcesWith(answered.fetcher, { language: "zh-CN" })))[0]).toBe(
      "huggingface",
    );
  });

  // protects=until IncarnaMind's ModelScope copy exists, the probe races hf-mirror.com in its place, and the mirror answering first leads; fails_when=the probe asks a copy that doesn't exist, or the mirror's answer leaves Hugging Face first; no_claim=how the real mirror answers.
  test("with no ModelScope copy, the probe races the mirror, which leads when it answers first", async () => {
    const { fetcher, asked } = probing({
      huggingface: false,
      modelscope: false,
      hfMirror: true,
    });
    expect(await order(sourcesWith(fetcher, { copies: {} }))).toEqual(["hf-mirror", "huggingface"]);
    expect(asked).toEqual(["huggingface.co", "hf-mirror.com"]);
    const nobody = probing({ huggingface: false, modelscope: false });
    expect((await order(sourcesWith(nobody.fetcher, { copies: {}, language: "zh-CN" })))[0]).toBe(
      "hf-mirror",
    );
  });

  // protects=the probe runs once for many files: its answer holds 10 minutes, and a change of the system proxy asks again; fails_when=each file probes, the answer never expires, or a proxy change keeps the old order; no_claim=how the host reads its proxy.
  test("the probe's answer holds ten minutes, and a new proxy asks again", async () => {
    const { fetcher, asked } = probing({ huggingface: true, modelscope: false });
    const clock = { now: 0 };
    const proxy = { value: "DIRECT" };
    const sources = sourcesWith(fetcher, { clock, proxy });
    await order(sources);
    await order(sources);
    expect(asked).toHaveLength(2);
    clock.now = PROBE_KEPT_MS - 1;
    await order(sources);
    expect(asked).toHaveLength(2);
    clock.now = PROBE_KEPT_MS;
    await order(sources);
    expect(asked).toHaveLength(4);
    proxy.value = "PROXY 127.0.0.1:7890";
    await order(sources);
    expect(asked).toHaveLength(6);
  });

  // protects=a source that failed a file goes last for the model's other files, and comes back once the probe runs again; the User's pick on a failed download's line leads; fails_when=every file waits on the failed source again, the demotion outlives the probe, or the pick is ignored; no_claim=the line itself.
  test("a source that failed goes last until the next probe, and the User's pick leads", async () => {
    const { fetcher } = probing({ huggingface: true, modelscope: false });
    const clock = { now: 0 };
    const sources = sourcesWith(fetcher, { clock });
    await order(sources);
    sources.failed("huggingface");
    expect(await order(sources)).toEqual(["modelscope", "hf-mirror", "r2", "huggingface"]);
    clock.now = PROBE_KEPT_MS;
    expect((await order(sources))[0]).toBe("huggingface");
    expect(await order(sourcesWith(fetcher, { choice: "modelscope" }))).toEqual([
      "modelscope",
      "huggingface",
      "hf-mirror",
      "r2",
    ]);
  });

  // protects=a copy that isn't set up is no source: until IncarnaMind's ModelScope and R2 copies exist, a file is tried at Hugging Face and hf-mirror only; fails_when=an empty copy yields a URL; no_claim=the copies' hosts.
  test("a copy that isn't set up is skipped", async () => {
    const { fetcher } = probing({ huggingface: true, modelscope: false });
    expect(await order(sourcesWith(fetcher, { copies: {} }))).toEqual(["huggingface", "hf-mirror"]);
  });

  // protects=a source may send a download on only to its own hosts, never from https to http: Hugging Face to its CDN on hf.co, hf-mirror.com on to Hugging Face, a copy to the hosts its config names; fails_when=a download follows a redirect to any other host, or to plain http; no_claim=which hosts a real CDN uses today.
  test("a source sends a download on only to its own hosts, and never to http", () => {
    const { fetcher } = probing({ huggingface: true, modelscope: false });
    const sources = sourcesWith(fetcher);
    const pinned = new URL(`${PINNED}onnx/model.onnx`);
    const to = (href: string) => new URL(href);
    const hf = (href: string) => sources.redirectAllowed("huggingface", pinned, pinned, to(href));
    expect(hf("https://us.aws.cdn.hf.co/xet/abc")).toBe(true);
    expect(hf("https://cdn-lfs.huggingface.co/abc")).toBe(true);
    expect(hf("https://evil.example.com/abc")).toBe(false);
    expect(hf("http://us.aws.cdn.hf.co/xet/abc")).toBe(false);
    expect(hf("https://hf.co.example.com/abc")).toBe(false);
    const mirror = new URL("https://hf-mirror.com/intfloat/x/resolve/abc/model.onnx");
    expect(
      sources.redirectAllowed("hf-mirror", mirror, mirror, to("https://huggingface.co/x")),
    ).toBe(true);
    const copy = new URL("https://models.example.com/multilingual-e5-small/model.onnx");
    expect(sources.redirectAllowed("r2", copy, copy, to("https://cdn.example.net/a"))).toBe(true);
    expect(sources.redirectAllowed("r2", copy, copy, to("https://us.aws.cdn.hf.co/a"))).toBe(false);
  });
});

// Hugging Face's stand-in, and a copy of the same files on another server, as ModelScope's would be.
async function twoSources(files: Record<string, number>) {
  const pinned = await startModelServer(files);
  const copy = await startModelServer({}, { server: pinned, folder: FOLDER });
  const port = new URL(copy.source.baseUrl).port;
  return { pinned, copy, copies: { modelscope: { url: `http://127.0.0.1:${port}/{folder}/` } } };
}

async function download(
  server: ModelServer,
  copies: ModelCopies,
  {
    signal = new AbortController().signal,
    stallMs,
  }: { signal?: AbortSignal; stallMs?: number } = {},
) {
  const directory = join(await mkdtemp(join(tmpdir(), "incarnamind-models-")), FOLDER);
  const sources = sourcesWith(LOCAL_FETCH, { copies, ...(stallMs !== undefined && { stallMs }) });
  const run = (at: string, abort = signal) =>
    downloadModel({
      directory: at,
      source: server.source,
      signal: abort,
      onProgress: () => {},
      sources,
    });
  return { directory, run, done: run(directory) };
}

const failure = (done: Promise<unknown>) =>
  done.then(
    () => {
      throw new Error("The download didn't fail.");
    },
    (error: unknown) => error,
  );

describe("A built-in model downloads from the next source when one fails (#1578)", {
  timeout: 30_000,
}, () => {
  // protects=a source that serves other bytes is rejected by the pinned SHA-256, and the next source's file is installed; fails_when=the wrong bytes are kept, or the download stops at the first source; no_claim=which source is faster.
  test("a source that serves a wrong file is rejected, and the next one is used", async () => {
    const { pinned, copy, copies } = await twoSources({ "model.onnx": 2048 });
    pinned.behave("model.onnx", { corrupt: true });
    const { directory, done } = await download(pinned, copies);
    await done;
    expect(new Uint8Array(await readFile(join(directory, "model.onnx")))).toEqual(
      pinned.contents.get("model.onnx"),
    );
    expect(copy.requests.map((each) => each.path)).toEqual([`${FOLDER}/model.onnx`]);
  });

  // protects=with Hugging Face's host blocked, the next source downloads each file and it passes its SHA-256 check; fails_when=the blocked source ends the download, or a file is installed unchecked; no_claim=how a proxy blocks it, which the fetcher stands in for.
  test("with Hugging Face blocked, the next source downloads the file and it passes its check", async () => {
    const { pinned, copy, copies } = await twoSources({ "model.onnx": 2048 });
    const blocked: typeof fetch = (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      return url.hostname === "huggingface.co"
        ? Promise.reject(new TypeError(`blocked: ${url.host}`))
        : LOCAL_FETCH(input, init);
    };
    const directory = join(await mkdtemp(join(tmpdir(), "incarnamind-models-")), FOLDER);
    await downloadModel({
      directory,
      source: {
        ...pinned.source,
        baseUrl: `https://huggingface.co/Xenova/${FOLDER}/resolve/abc123/`,
      },
      signal: new AbortController().signal,
      onProgress: () => {},
      sources: sourcesWith(blocked, { copies }),
    });
    expect(pinned.requests).toEqual([]);
    expect(copy.requests.map((each) => each.path)).toEqual([`${FOLDER}/model.onnx`]);
    expect(new Uint8Array(await readFile(join(directory, "model.onnx")))).toEqual(
      pinned.contents.get("model.onnx"),
    );
  });

  // protects=a file that gets no bytes for the stall time moves to the next source, which resumes it with a Range request from where the first stopped, and the joined file passes its check; fails_when=the stall waits forever, starts over, or keeps a file that fails its SHA-256; no_claim=the 25 s itself, which the default carries.
  test("a stall moves to the next source, which resumes the file where it stopped", async () => {
    const { pinned, copy, copies } = await twoSources({ "model.onnx": 4096 });
    pinned.behave("model.onnx", { stallAfter: 1000 });
    const { directory, done } = await download(pinned, copies, { stallMs: 2000 });
    await done;
    expect(copy.requests).toEqual([
      expect.objectContaining({ path: `${FOLDER}/model.onnx`, range: "bytes=1000-" }),
    ]);
    expect(new Uint8Array(await readFile(join(directory, "model.onnx")))).toEqual(
      pinned.contents.get("model.onnx"),
    );
  });

  // protects=a source that sends a download on to a host that isn't its own is refused, and its error names that host; the next source is used; fails_when=the redirect is followed, or the download stops there; no_claim=the hosts a real source owns, which the rule's own test covers.
  test("a redirect to another host is refused, and the next source is used", async () => {
    const { pinned, copy, copies } = await twoSources({ "model.onnx": 2048 });
    const elsewhere = await startModelServer({ "model.onnx": 2048 });
    pinned.behave("model.onnx", { redirectTo: `${elsewhere.source.baseUrl}model.onnx` });
    const sources = sourcesWith(LOCAL_FETCH, { copies });
    const directory = join(await mkdtemp(join(tmpdir(), "incarnamind-models-")), FOLDER);
    await downloadModel({
      directory,
      source: pinned.source,
      signal: new AbortController().signal,
      onProgress: () => {},
      sources,
    });
    expect(elsewhere.requests).toEqual([]);
    expect(copy.requests.map((each) => each.path)).toEqual([`${FOLDER}/model.onnx`]);
  });

  // protects=a redirect from https to plain http is refused, so a file's path never goes out unencrypted; fails_when=it is followed; no_claim=Hugging Face's own redirects.
  test("a redirect from https to http is refused", async () => {
    const asked: string[] = [];
    const fetcher: typeof fetch = async (input) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      asked.push(url.href);
      if (url.protocol === "https:" && url.host === "huggingface.co") {
        return new Response(null, {
          status: 302,
          headers: { location: `http://${url.host}${url.pathname}` },
        });
      }
      throw new TypeError(`${url.host} can't be reached`);
    };
    const directory = join(await mkdtemp(join(tmpdir(), "incarnamind-models-")), FOLDER);
    const error = await failure(
      downloadModel({
        directory,
        source: { baseUrl: PINNED, files: [FILE] },
        signal: new AbortController().signal,
        onProgress: () => {},
        sources: sourcesWith(fetcher, { copies: {} }),
      }),
    );
    expect(asked.some((href) => href.startsWith("http://"))).toBe(false);
    expect((error as ModelDownloadError).sources?.[0]).toMatchObject({
      source: "huggingface",
      message: expect.stringContaining("http://huggingface.co"),
    });
  });

  // protects=a 200 whose length isn't the file's (a short error page) is refused before anything is written, so the next source downloads the file once, from its start; fails_when=the page is kept as the file's start and the next source resumes after it; no_claim=a server that sends no length.
  test("a short error page isn't kept: the next source downloads from the start", async () => {
    const { pinned, copy, copies } = await twoSources({ "model.onnx": 4096 });
    pinned.behave("model.onnx", { errorPage: true });
    const { directory, done } = await download(pinned, copies);
    await done;
    expect(copy.requests).toEqual([
      expect.objectContaining({ path: `${FOLDER}/model.onnx`, range: null }),
    ]);
    expect((await readFile(join(directory, "model.onnx"))).byteLength).toBe(4096);
  });

  // protects=a source that cuts the file short (a truncated download) moves to the next; fails_when=a short file is installed or the download gives up; no_claim=why the connection dropped.
  test("a file cut short moves to the next source", async () => {
    const { pinned, copies } = await twoSources({ "model.onnx": 4096 });
    pinned.behave("model.onnx", { cutAfter: 100 });
    const { directory, done } = await download(pinned, copies);
    await done;
    expect((await readFile(join(directory, "model.onnx"))).byteLength).toBe(4096);
  });

  // protects=with every source failing (one down, one serving wrong bytes), the error says what each said, in the order tried, and nothing is installed: no file in place and no record of a finished download; fails_when=the error names one source, a wrong file is kept, or verified.json is written; no_claim=the problem line's words, which the renderer shows.
  test("with every source failing, it says what each said, and nothing is installed", async () => {
    const { pinned, copy, copies } = await twoSources({ "model.onnx": 2048 });
    pinned.behave("model.onnx", { corrupt: true });
    await copy.close();
    const { directory, done } = await download(pinned, copies);
    const error = await failure(done);
    expect(error).toBeInstanceOf(ModelDownloadError);
    expect((error as ModelDownloadError).sources?.map((each) => each.source)).toEqual([
      "huggingface",
      "modelscope",
    ]);
    expect(existsSync(join(directory, "model.onnx"))).toBe(false);
    expect(existsSync(join(directory, "verified.json"))).toBe(false);
  });

  // protects=offline, every source fails to connect, and the download fails as a network problem naming each, rather than hanging; fails_when=it hangs, or calls it a broken file; no_claim=the operating system's own offline signal.
  test("offline, every source fails as a network problem", async () => {
    const { pinned, copy, copies } = await twoSources({ "model.onnx": 2048 });
    await pinned.close();
    await copy.close();
    const error = await failure((await download(pinned, copies)).done);
    expect(error).toMatchObject({ kind: "network" });
    expect((error as ModelDownloadError).sources).toHaveLength(2);
  });

  // protects=a quit halfway keeps what was downloaded, and the next start resumes it with a Range request instead of starting over; fails_when=the partial file is lost, or the next download asks for the whole file; no_claim=a quit during the SHA-256 check.
  test("a quit halfway keeps the partial file, and the next download resumes it", async () => {
    const { pinned, copies } = await twoSources({ "model.onnx": 10_000 });
    pinned.behave("model.onnx", { stallAfter: 3000 });
    const quit = new AbortController();
    const { directory, run, done } = await download(pinned, copies, { signal: quit.signal });
    await expect
      .poll(
        async () =>
          (await readFile(join(directory, "model.onnx.partial")).catch(() => null))?.byteLength,
      )
      .toBe(3000);
    quit.abort();
    await failure(done);
    pinned.behave("model.onnx", {});
    await run(directory, new AbortController().signal);
    expect(pinned.requests.at(-1)?.range).toBe("bytes=3000-");
    expect(new Uint8Array(await readFile(join(directory, "model.onnx")))).toEqual(
      pinned.contents.get("model.onnx"),
    );
  });

  // protects=Try again pressed twice at once downloads the model once, through the core as the app does: each file is fetched once, from the source that serves it right, and a source that failed one file goes last for the next; fails_when=two downloads run side by side, a file is fetched twice, or the failed source is asked first for the next file; no_claim=the line's button, which the smoke test presses.
  test("twice at once, the model downloads once, the next file from the source that worked", async () => {
    const folder = BUILT_IN_EMBEDDING_MODEL.folder;
    const pinned = await startModelServer({ "onnx/model.onnx": 4096, "tokenizer.json": 512 });
    pinned.behave("onnx/model.onnx", { corrupt: true });
    const copy = await startModelServer({}, { server: pinned, folder });
    const core = startCore(await createTempDataFolder(), {
      embedder: createControlledEmbedder(),
      embeddingModelSource: pinned.source,
      modelDownloads: {
        fetch: LOCAL_FETCH,
        copies: { modelscope: { url: `${copy.source.baseUrl}{folder}/` } },
      },
    });
    await turnOnEmbeddings(core);
    await Promise.all([core.downloadEmbeddingModel(), core.downloadEmbeddingModel()]);
    await waitForModel(core, (status) => status.state === "ready");
    expect(pinned.requests.map((each) => each.path)).toEqual(["onnx/model.onnx"]);
    expect(copy.requests.map((each) => each.path)).toEqual([
      `${folder}/onnx/model.onnx`,
      `${folder}/tokenizer.json`,
    ]);
    core.close();
  });

  // protects=the models that tell a Meeting's speakers apart take the same sources as the others, so a User where Hugging Face fails still gets them; fails_when=they ask Hugging Face alone, or the copy's file isn't the one installed; no_claim=the speaker pass itself, which its own test covers.
  test("the speaker models take the next source when Hugging Face serves a wrong file", async () => {
    const segmentation = await startModelServer({ [SPEAKER_SEGMENTATION.file]: 2048 });
    const embedding = await startModelServer({ [SPEAKER_EMBEDDING.file]: 2048 });
    segmentation.behave(SPEAKER_SEGMENTATION.file, { corrupt: true });
    const copy = await startModelServer(
      {},
      { server: segmentation, folder: SPEAKER_SEGMENTATION.folder },
    );
    const model = createSpeakerModel({
      dataDir: await mkdtemp(join(tmpdir(), "incarnamind-speakers-")),
      source: { segmentation: segmentation.source, embedding: embedding.source },
      sources: sourcesWith(LOCAL_FETCH, {
        copies: { modelscope: { url: `${copy.source.baseUrl}{folder}/` } },
      }),
      log: silentLogger,
    });
    const files = await model.files();
    model.close();
    expect(new Uint8Array(await readFile(files.segmentation))).toEqual(
      segmentation.contents.get(SPEAKER_SEGMENTATION.file),
    );
    expect(new Uint8Array(await readFile(files.embedding))).toEqual(
      embedding.contents.get(SPEAKER_EMBEDDING.file),
    );
    expect(copy.requests.map((each) => each.path)).toContain(
      `${SPEAKER_SEGMENTATION.folder}/${SPEAKER_SEGMENTATION.file}`,
    );
  });
});
