/**
 * Dropped scans are classified from their first pages while the rest is read (#2308): every
 * dropped scan's first 12 pages are read before any scan's later pages, Organize and Tags start
 * once those pages are read, and reading the rest changes neither the Folder Organize proposes
 * nor the Tags.
 */
import { createCanvas } from "@napi-rs/canvas";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, test, vi } from "vitest";
import type { Core, Document, Embedder, TextRecognizer } from "../../src/core";
import {
  type DocumentHead,
  type ReadingChannel,
  runJob,
} from "../../src/core/documents/processing";
import { createFakeTextRecognizer } from "../../src/core/documents/scan/fake";
import { createFakeEmbedder } from "../../src/core/embedding/fake";
import { createTempDataFolder, NO_MODEL_FILES, startCore } from "../helpers/core";
import { createSourceFolder, waitForProcessing, writeSourceFile } from "../helpers/documents";
import { turnOnEmbeddings } from "../helpers/embedding";
import { proposedFor } from "../helpers/library";
import { buildPdf, type PdfPage } from "../helpers/pdf";

/** A grey page with a few dark rows, as a scanner makes one: small, so drawing it is quick. */
function scanPicture(): Uint8Array {
  const canvas = createCanvas(60, 85);
  const context = canvas.getContext("2d");
  context.fillStyle = "#e4e4e4";
  context.fillRect(0, 0, 60, 85);
  context.fillStyle = "#333";
  for (let row = 10; row < 80; row += 6) context.fillRect(6, row, 48, 2);
  return canvas.toBuffer("image/jpeg");
}
const PICTURE = scanPicture();

const LANGUAGES = {
  en: {
    sheet: (page: number) =>
      Array.from(
        { length: 16 },
        (_, line) =>
          `Sheet ${page}, line ${line + 1}: the readings were copied from the field book and initialled by the clerk on duty.`,
      ),
    folders: [
      { name: "Harbour", description: "Port and shipping work.", says: "berth" },
      { name: "Orchard", description: "Fruit growing.", says: "apple" },
    ],
    tag: { name: "Survey", description: "Measurements taken on site." },
    cover: (says: string, index: number) => ({
      lines: [
        `Survey ${index} of the ${says} at the north quay.`,
        `Every ${says} reading below was taken by the Larkspur survey crew in March.`,
        "The tables on the following scanned sheets were copied by hand.",
      ],
    }),
  },
  "zh-CN": {
    sheet: (page: number) =>
      Array.from(
        { length: 16 },
        (_, line) =>
          `第 ${page} 页第 ${line + 1} 行：读数抄自现场记录本，由值班记录员核对并签名，日期写在页脚。`,
      ),
    folders: [
      { name: "港口", description: "码头和航运工作。", says: "泊位" },
      { name: "果园", description: "水果种植。", says: "苹果" },
    ],
    tag: { name: "测量", description: "现场测得的数据。" },
    cover: (says: string, index: number) => ({
      chineseLines: [
        `北码头${says}测量第 ${index} 份。`,
        `以下每项${says}读数由青禾测量队在三月测得。`,
        "后面扫描页上的表格为手工抄录。",
      ],
    }),
  },
} as const;
type Language = keyof typeof LANGUAGES;

/**
 * The text recognition model, scripted: page n reads `lines(n)`. Pages after the first 12 wait
 * until `release`, so a test sees where reading is when they are first asked for.
 */
function scriptedReader(lines: (page: number) => readonly string[], pages: number) {
  const fake = createFakeTextRecognizer({
    script: {
      pages: Object.fromEntries(
        Array.from({ length: pages }, (_, index) => [
          String(index + 1),
          { lines: [...lines(index + 1)] },
        ]),
      ),
    },
  });
  let open = () => {};
  const later = new Promise<void>((resolve) => {
    open = resolve;
  });
  const asked = { first: 0, later: 0 };
  const recognizer: TextRecognizer = {
    load: (files) => fake.load(files),
    async read(picture, page) {
      if (page > 12) {
        asked.later++;
        await later;
      } else asked.first++;
      return fake.read(picture, page);
    },
    readFile: (file, page) => fake.readFile(file, page),
    close: () => fake.close(),
  };
  return { recognizer, asked, release: () => open() };
}

/**
 * A model on this computer that Organize and Tags ask: it files a Document in the Folder whose
 * word its excerpt says, and gives it the one Tag. It counts what it was asked.
 */
function sortingModel(
  folders: readonly { id: string; says: string }[],
  tag: { id: string; name: string },
) {
  const asked = { organize: [] as string[], tags: [] as string[] };
  let gate: Promise<void> | null = null;
  let open = () => {};
  const model = new MockLanguageModelV4({
    doGenerate: async (options) => {
      const schema =
        options.responseFormat?.type === "json" ? options.responseFormat.schema : undefined;
      const properties = (schema as { properties?: Record<string, unknown> } | undefined)
        ?.properties;
      const prompt = JSON.stringify(options.prompt);
      const folder = folders.find((each) => prompt.includes(each.says));
      let text: string;
      if (properties && "groupId" in properties) {
        asked.organize.push(prompt);
        text = JSON.stringify({ groupId: folder?.id ?? null, tags: folder ? [tag.id] : [] });
      } else {
        asked.tags.push(prompt);
        text = JSON.stringify({ tags: folder ? [tag.name] : [], newTags: [] });
      }
      if (gate) await gate;
      return {
        content: [{ type: "text", text }],
        finishReason: { unified: "stop", raw: undefined },
        warnings: [],
        usage: {
          inputTokens: { total: 5, noCache: 5, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: 1, text: 1, reasoning: undefined },
        },
      };
    },
  });
  return {
    model,
    asked,
    /** Holds every answer until `release`. */
    hold() {
      gate = new Promise((resolve) => {
        open = resolve;
      });
    },
    release() {
      gate = null;
      open();
    },
  };
}

/** A PDF whose first page is text and whose other pages are scans. */
const scan = (cover: PdfPage, pages: number) =>
  buildPdf([cover, ...Array.from({ length: pages - 1 }, () => ({ scan: PICTURE }))]);

async function addFiles(core: Core, files: [string, Uint8Array][]): Promise<Document[]> {
  const sources = await createSourceFolder();
  const paths = [];
  for (const [name, contents] of files) paths.push(await writeSourceFile(sources, name, contents));
  return (await core.addDocuments(paths)).documents;
}

/** Each of these Documents' text still being read: none read whole yet. */
async function statusesOf(core: Core, ids: readonly string[]) {
  const listed = await core.listDocuments();
  return ids.map((id) => listed.find((each) => each.id === id)?.status);
}

// Waits for states, with room for a busy runner reading scans on worker threads.
const WAIT = { timeout: 120_000, interval: 100 };

async function sortingCore(
  language: Language,
  pages: number,
  options: { folders?: boolean; sheet?: (page: number) => readonly string[] } = {},
) {
  const words = LANGUAGES[language];
  const reader = scriptedReader(options.sheet ?? words.sheet, pages);
  let sorting: ReturnType<typeof sortingModel> | undefined;
  const dataDir = await createTempDataFolder();
  const core = startCore(dataDir, {
    textRecognizer: reader.recognizer,
    textRecognitionModelSource: NO_MODEL_FILES,
    scansAtOnce: 1,
    createChatModel: () => {
      if (!sorting) throw new Error("No model yet.");
      return sorting.model;
    },
  });
  if (language === "zh-CN") await core.updateSettings({ user: { language: "zh-CN" } });
  const provider = await core.saveChatProvider({ kind: "ollama", modelId: "main-model" });
  const folders =
    options.folders === false
      ? []
      : await Promise.all(
          words.folders.map(async (folder) => ({
            ...(await core.createLibraryGroup({
              name: folder.name,
              description: folder.description,
            })),
            says: folder.says,
          })),
        );
  const tag = await core.createTag(words.tag);
  sorting = sortingModel(
    folders.length > 0 ? folders : words.folders.map((folder) => ({ id: "", says: folder.says })),
    tag,
  );
  await core.saveLibrarySettings({
    classifier: { kind: "chat", choice: { providerId: provider.id, modelId: "small-classifier" } },
    automatic: true,
  });
  const model = sorting;
  return { core, dataDir, reader, folders, tag, model, words };
}

describe("Dropped scans are classified from their first pages (#2308)", {
  timeout: 240_000,
}, () => {
  // protects=ten 46-page scans dropped together each have a Folder proposed and are tagged from their first pages before any one is read whole, while no page after the 12th has been read; fails_when=Organize waits for a scan to be read in full, or one scan's later pages are read while another's first pages wait; no_claim=how fast the real text recognition model reads a page.
  test("ten 46-page scans each have a Folder proposed before any one of them is read whole", async () => {
    const { core, reader, folders, tag } = await sortingCore("en", 46);
    const [harbour] = folders;
    if (!harbour) throw new Error("No Folder.");
    const added = await addFiles(
      core,
      Array.from({ length: 10 }, (_, index) => [
        `Quay survey ${index + 1}.pdf`,
        scan(LANGUAGES.en.cover("berth", index + 1), 46),
      ]),
    );
    const ids = added.map((each) => each.id);
    expect(ids).toHaveLength(10);
    try {
      await vi.waitFor(async () => {
        const proposed = await Promise.all(ids.map((id) => proposedFor(core, id)));
        expect(proposed).toEqual(Array(10).fill(harbour.id));
      }, WAIT);
      // Still being read, every one of them, while its Folder is proposed and it is tagged.
      for (const status of await statusesOf(core, ids))
        expect(["queued", "extracting"]).toContain(status);
      const listed = (await core.listDocuments()).filter((each) => ids.includes(each.id));
      expect(listed.map((each) => each.tags.map((link) => link.tagId))).toEqual(
        Array(10).fill([tag.id]),
      );
      // Each one's 11 scanned first pages (its first page is text) were read once, while every
      // page after the 12th still waited.
      expect(reader.asked.first).toBe(110);
    } finally {
      reader.release();
    }
  });

  // protects=a scan has the Folder its first pages call for proposed, in English and in Chinese, gets its Tag, and keeps both, asked once, when the rest of it is read; fails_when=reading the rest sorts or tags it again, or the first pages aren't what decides it; no_claim=which Folder a real model picks.
  test.each(["en", "zh-CN"] as const)(
    "%s: the first pages decide the Folder, and reading the rest changes nothing",
    async (language) => {
      const { core, reader, folders, tag, model, words } = await sortingCore(language, 14);
      const added = await addFiles(
        core,
        words.folders.map((folder, index) => [
          `${folder.name} ${index + 1}.pdf`,
          scan(words.cover(folder.says, index + 1), 14),
        ]),
      );
      const ids = added.map((each) => each.id);
      const proposedIn = () => Promise.all(ids.map((id) => proposedFor(core, id)));
      const wanted = folders.map((folder) => folder.id);
      await vi.waitFor(async () => expect(await proposedIn()).toEqual(wanted), WAIT);
      expect(await statusesOf(core, ids)).not.toContain("ready");
      expect(model.asked.organize).toHaveLength(2);

      reader.release();
      await waitForProcessing(core, ids, WAIT.timeout);
      expect(await statusesOf(core, ids)).toEqual(["ready", "ready"]);
      expect(await proposedIn()).toEqual(wanted);
      const listed = (await core.listDocuments()).filter((each) => ids.includes(each.id));
      expect(listed.map((each) => each.tags.map((link) => link.tagId))).toEqual([
        [tag.id],
        [tag.id],
      ]);
      expect(model.asked.organize).toHaveLength(2);
      expect(model.asked.tags).toHaveLength(0);
    },
  );

  // protects=quit while the rest of a scan is read, the next start reads on from the page it reached, keeps the Folder and Tag, and asks nothing again; fails_when=the restart reads the first pages again or sorts or tags the scan again; no_claim=what a crash in the middle of a page loses.
  test("a restart reads on from where it was, and doesn't sort again", async () => {
    const { core, dataDir, folders, tag, model } = await sortingCore("en", 14);
    const [document] = await addFiles(core, [
      ["Quay survey.pdf", scan(LANGUAGES.en.cover("berth", 1), 14)],
    ]);
    if (!document) throw new Error("Not added.");
    await vi.waitFor(
      async () => expect(await proposedFor(core, document.id)).toBe(folders[0]?.id),
      WAIT,
    );
    core.close();

    const reader = scriptedReader(LANGUAGES.en.sheet, 14);
    reader.release();
    const reopened = startCore(dataDir, {
      textRecognizer: reader.recognizer,
      textRecognitionModelSource: NO_MODEL_FILES,
      scansAtOnce: 1,
      createChatModel: () => model.model,
    });
    const [read] = await waitForProcessing(reopened, [document.id], WAIT.timeout);
    expect(read?.status).toBe("ready");
    expect(read?.tags.map((link) => link.tagId)).toEqual([tag.id]);
    expect(await proposedFor(reopened, document.id)).toBe(folders[0]?.id);
    // Only pages 13 and 14 were left to read; the first 12 were kept.
    expect([reader.asked.first, reader.asked.later]).toEqual([0, 2]);
    expect(model.asked.organize).toHaveLength(1);
  });

  // protects=a proposal the User discards while the rest of the scan is read stays discarded once the rest is read; fails_when=reading the rest proposes the Document again; no_claim=the Review's wording.
  test("a proposal discarded while the rest is read stays discarded", async () => {
    const { core, reader, folders, model } = await sortingCore("en", 14);
    const [document] = await addFiles(core, [
      ["Quay survey.pdf", scan(LANGUAGES.en.cover("berth", 1), 14)],
    ]);
    if (!document) throw new Error("Not added.");
    await vi.waitFor(
      async () => expect(await proposedFor(core, document.id)).toBe(folders[0]?.id),
      WAIT,
    );
    const { items } = await core.getOrganizeReview();
    await core.discardOrganizeReview(items.map((item) => item.id));
    expect(await proposedFor(core, document.id)).toBeNull();

    reader.release();
    await waitForProcessing(core, [document.id], WAIT.timeout);
    expect(await proposedFor(core, document.id)).toBeNull();
    expect(model.asked.organize).toHaveLength(1);
  });

  // protects=with no Folders, Tags are given to a scan from its first pages while the rest is read, the row says it is being tagged meanwhile, and it isn't asked again when read whole; fails_when=tagging waits for the whole scan, shows as waiting while it is being tagged, or asks twice; no_claim=the Tag a real model picks.
  test("Tags come from the first pages, once", async () => {
    const { core, reader, tag, model } = await sortingCore("en", 14, { folders: false });
    model.hold();
    const [document] = await addFiles(core, [
      ["Quay survey.pdf", scan(LANGUAGES.en.cover("berth", 1), 14)],
    ]);
    if (!document) throw new Error("Not added.");
    const listed = async () => (await core.listDocuments()).find((each) => each.id === document.id);
    await vi.waitFor(() => expect(model.asked.tags).toHaveLength(1), WAIT);
    expect([(await listed())?.status, (await listed())?.tagging]).toEqual([
      "extracting",
      "tagging",
    ]);
    model.release();
    const wanted = [tag.id];
    await vi.waitFor(async () => {
      const found = await listed();
      expect(found?.tagging).toBe("tagged");
      expect(found?.tags.map((link) => link.tagId)).toEqual(wanted);
    }, WAIT);
    expect(await statusesOf(core, [document.id])).not.toContain("ready");
    reader.release();
    await waitForProcessing(core, [document.id], WAIT.timeout);
    expect((await listed())?.tags.map((link) => link.tagId)).toEqual(wanted);
    expect(model.asked.tags).toHaveLength(1);
  });

  // protects=a scan whose first 12 pages hold too little text for Organize's Passages waits to be read whole, then has its Folder proposed; fails_when=it is sorted from a few words on near-blank pages, or never sorted; no_claim=how much text a real scan's cover has.
  test("near-blank first pages wait for the whole scan", async () => {
    const { core, reader, folders, model } = await sortingCore("en", 14, {
      sheet: (page) =>
        page <= 12
          ? [`Sheet ${page}.`]
          : LANGUAGES.en.sheet(page).map((line) => `${line} The berth was dredged.`),
    });
    const [document] = await addFiles(core, [
      [
        "Quay survey.pdf",
        buildPdf([
          { lines: ["Quay survey."] },
          ...Array.from({ length: 13 }, () => ({ scan: PICTURE })),
        ]),
      ],
    ]);
    if (!document) throw new Error("Not added.");
    await vi.waitFor(() => expect(reader.asked.later).toBe(1), WAIT);
    expect(model.asked.organize).toHaveLength(0);
    reader.release();
    await waitForProcessing(core, [document.id], WAIT.timeout);
    await vi.waitFor(
      async () => expect(await proposedFor(core, document.id)).toBe(folders[0]?.id),
      WAIT,
    );
    expect(model.asked.organize).toHaveLength(1);
  });

  // protects=a born-digital PDF is tagged as soon as its text is read, while its Passages are still embedded; fails_when=tagging waits for the embedding; no_claim=how long embedding takes.
  test("a born-digital PDF is tagged while it is still embedded", async () => {
    let open = () => {};
    const embedded = new Promise<void>((resolve) => {
      open = resolve;
    });
    const fake = createFakeEmbedder();
    const held: Embedder = {
      load: (files) => fake.load(files),
      async embed(text) {
        await embedded;
        return fake.embed(text);
      },
      close: () => fake.close(),
    };
    const model = sortingModel([{ id: "", says: "berth" }], { id: "", name: "Survey" });
    const later = startCore(await createTempDataFolder(), {
      embedder: held,
      createChatModel: () => model.model,
    });
    await turnOnEmbeddings(later);
    const provider = await later.saveChatProvider({ kind: "ollama", modelId: "main-model" });
    const own = await later.createTag(LANGUAGES.en.tag);
    await later.saveLibrarySettings({
      classifier: {
        kind: "chat",
        choice: { providerId: provider.id, modelId: "small-classifier" },
      },
      automatic: true,
    });
    const [document] = await addFiles(later, [
      [
        "Quay report.pdf",
        buildPdf(
          Array.from({ length: 30 }, (_, index) => ({
            lines: [`Page ${index + 1}. Every berth was surveyed by the Larkspur crew in March.`],
          })),
        ),
      ],
    ]);
    if (!document) throw new Error("Not added.");
    try {
      await vi.waitFor(async () => {
        const found = (await later.listDocuments()).find((each) => each.id === document.id);
        expect(found?.tags.map((link) => link.tagId)).toEqual([own.id]);
        expect(found?.status).toBe("embedding");
      }, WAIT);
      expect(model.asked.tags).toHaveLength(1);
    } finally {
      open();
    }
  });
});

describe("A scan says its first pages only when pages follow them (#2308)", {
  timeout: 120_000,
}, () => {
  // protects=a scan with scanned pages after its first 12 says those 12 once, before reading on, with 12 pages and Passages to classify from, while a scan of 12 pages or fewer says nothing, its whole read being a moment away; fails_when=a short scan stops to give way just before it ends, or a long one never says its first pages; no_claim=the order scans are read in, which the tests above cover.
  test.each([
    [14, 1],
    [12, 0],
  ])("a %i-page scan says its first pages %i time(s)", async (pages, times) => {
    const sources = await createSourceFolder();
    const file = await writeSourceFile(
      sources,
      "Quay survey.pdf",
      scan(LANGUAGES.en.cover("berth", 1), pages),
    );
    const fake = createFakeTextRecognizer({
      script: {
        pages: Object.fromEntries(
          Array.from({ length: pages }, (_, index) => [
            String(index + 1),
            { lines: [...LANGUAGES.en.sheet(index + 1)] },
          ]),
        ),
      },
    });
    // The fake reads no model files.
    await fake.load({ detector: "", recognizer: "" });
    const said: { head: DocumentHead; after: number }[] = [];
    let read = 0;
    const channel: ReadingChannel = {
      signal: new AbortController().signal,
      progress: () => undefined,
      log: () => undefined,
      head: (head) => said.push({ head, after: read }),
      read: (page, picture) => {
        read++;
        return fake.read(picture, page);
      },
      readFile: () => new Promise(() => undefined),
    };
    const result = await runJob(
      {
        task: "process",
        documentId: "scan",
        kind: "pdf",
        file,
        scan: { reader: "fake", keep: null, head: { pages: 12, passages: 6 } },
      },
      channel,
    );
    expect(result.outcome).toBe("ready");
    expect(said.map(({ head, after }) => [head.units.length, head.passages.length, after])).toEqual(
      Array(times).fill([12, 6, 11]),
    );
  });
});
