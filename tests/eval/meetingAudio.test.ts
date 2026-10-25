import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { download } from "../../eval/lib/download";
import { tarEntries } from "../../eval/lib/tar";
import { encodeWav, monoSamples, toPcm16, wavHeader } from "../../eval/lib/wav";
import { extractEntries, parseTextGrid, speakerOf } from "../../eval/meetings/alimeeting";
import {
  amiReference,
  amiUtterances,
  headsetTracks,
  ofMeeting,
  talkTimes,
} from "../../eval/meetings/ami";
import { sha256 } from "../../eval/meetings/cache";
import {
  gateTurns,
  mixTracks,
  onlineTracks,
  overlayClips,
  placeClips,
} from "../../eval/meetings/tracks";
import { chunked, floatWav, pcmWav, tarOf } from "../helpers/meetingFiles";

let folder: string;
beforeEach(async () => {
  folder = await mkdtemp(join(tmpdir(), "incarnamind-meetings-test-"));
});
afterEach(async () => {
  await rm(folder, { recursive: true, force: true });
});

async function collect(content: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const parts: Uint8Array[] = [];
  for await (const part of content) parts.push(part);
  return Buffer.concat(parts);
}

describe("WAV files", () => {
  test("mono 16 kHz audio round-trips, 16-bit or 32-bit float", () => {
    const samples = Float32Array.from([0, 0.5, -0.5, 0.25]);
    expect(Array.from(monoSamples(encodeWav(toPcm16(samples))))).toEqual([0, 0.5, -0.5, 0.25]);
    expect(Array.from(monoSamples(floatWav(samples)))).toEqual([0, 0.5, -0.5, 0.25]);
  });

  test("anything else is refused, and the reason is plain", () => {
    expect(() => monoSamples(pcmWav(new Int16Array(4), 2), "a.wav")).toThrow(/a\.wav isn't mono/);
    expect(() => monoSamples(pcmWav(new Int16Array(4), 1, 8000), "a.wav")).toThrow(/8000 Hz/);
    expect(() => monoSamples(Buffer.from("not audio, just text"), "a.wav")).toThrow(/isn't a WAV/);
  });

  test("an extensible header (what an eight-channel array writes) names its format in the extension", () => {
    const header = wavHeader(pcmWav(new Int16Array(16), 8, 16_000, true));
    expect(header).toMatchObject({
      channels: 8,
      rate: 16_000,
      bits: 16,
      float: false,
      dataBytes: 32,
    });
  });
});

describe("Reading a tar stream", () => {
  const files = [
    { name: "folder/", data: new Uint8Array(0), type: "5" },
    { name: "folder/a.txt", data: Buffer.from("hello") },
    { name: "folder/big.bin", data: Buffer.alloc(1300, 7) },
    { name: "././@LongLink", data: Buffer.from(`${"long/".repeat(30)}c.txt\0`), type: "L" },
    { name: "short", data: Buffer.from("named by the long link") },
    { name: "d.txt", data: Buffer.from("with a prefix"), prefix: "some/where" },
  ];

  test("gives each entry's name, kind and bytes, however the bytes arrive", async () => {
    for (const size of [1, 100, 512, 100_000]) {
      const seen: [string, boolean, string][] = [];
      for await (const entry of tarEntries(chunked(tarOf(files), size))) {
        seen.push([
          entry.name,
          entry.isFile,
          (await collect(entry.content)).subarray(0, 8).toString(),
        ]);
      }
      expect(seen).toEqual([
        ["folder/", false, ""],
        ["folder/a.txt", true, "hello"],
        ["folder/big.bin", true, "\u0007".repeat(8)],
        [`${"long/".repeat(30)}c.txt`, true, "named by"],
        ["some/where/d.txt", true, "with a p"],
      ]);
    }
  });

  test("skips what the caller doesn't read, and can be left early", async () => {
    const names: string[] = [];
    for await (const entry of tarEntries(chunked(tarOf(files), 300))) {
      names.push(entry.name);
      if (entry.name === "folder/a.txt") break;
    }
    expect(names).toEqual(["folder/", "folder/a.txt"]);
    const all: string[] = [];
    for await (const entry of tarEntries(chunked(tarOf(files), 300))) all.push(entry.name);
    expect(all).toHaveLength(5);
  });

  test("an archive that ends inside a file says so", async () => {
    const cut = tarOf(files).subarray(0, 4 * 512 + 100);
    await expect(
      (async () => {
        for await (const entry of tarEntries(chunked(cut, 64))) await collect(entry.content);
      })(),
    ).rejects.toThrow(/ends inside a file/);
  });
});

describe("Checked downloads", () => {
  const bytes = Buffer.from("some audio");
  const pinned = { url: "https://example.test/a", sha256: sha256(bytes), bytes: bytes.length };
  const serving = (body: Buffer): typeof fetch =>
    (async () => new Response(new Uint8Array(body))) as unknown as typeof fetch;

  test("keeps a download that matches, and fetches nothing when the file is there", async () => {
    const path = join(folder, "sources", "a");
    expect(await download(serving(bytes), pinned, path)).toBe(true);
    expect(await readFile(path)).toEqual(bytes);
    const never = (async () => {
      throw new Error("no network");
    }) as unknown as typeof fetch;
    expect(await download(never, pinned, path)).toBe(false);
  });

  test("keeps nothing that doesn't match", async () => {
    const path = join(folder, "a");
    await expect(download(serving(Buffer.from("other bytes")), pinned, path)).rejects.toThrow(
      /doesn't match its pinned SHA-256/,
    );
    await expect(readFile(path)).rejects.toThrow();
    await expect(readFile(`${path}.partial`)).rejects.toThrow();
  });

  test("a missing file is a plain error after the tries", async () => {
    const missing = (async () => new Response("no", { status: 404 })) as unknown as typeof fetch;
    await expect(download(missing, pinned, join(folder, "a"))).rejects.toThrow(/404/);
  });
});

describe("Tracks", () => {
  const ramp = (value: number, length: number) => new Float32Array(length).fill(value);

  test("clips are placed where they were said; a later clip replaces what is under it", () => {
    const out = placeClips(
      [
        { start: 0, samples: ramp(0.5, 8) },
        { start: 4 / 16_000, samples: ramp(0.25, 8) },
      ],
      16,
    );
    expect(Array.from(out)).toEqual([
      ...Array(4).fill(0.5),
      ...Array(8).fill(0.25),
      ...Array(4).fill(0),
    ]);
  });

  test("overlaid clips add up, and one running past the end is cut", () => {
    const out = overlayClips(
      [
        { start: 0, samples: ramp(0.25, 8) },
        { start: 4 / 16_000, samples: ramp(0.25, 8) },
      ],
      10,
    );
    expect(Array.from(out)).toEqual([
      ...Array(4).fill(0.25),
      ...Array(4).fill(0.5),
      ...Array(2).fill(0.25),
    ]);
  });

  test("a mix is turned down as a whole only when it would clip", () => {
    expect(Array.from(mixTracks([ramp(0.25, 2), ramp(0.25, 2)]))).toEqual([0.5, 0.5]);
    const loud = mixTracks([ramp(0.9, 2), ramp(0.9, 2)]);
    expect(Math.max(...loud)).toBeCloseTo(0.99, 5);
  });

  test("the microphone is Me's track and the system audio everyone else's, as separate tracks", () => {
    const tracks = new Map([
      ["A", ramp(0.1, 4)],
      ["B", ramp(0.2, 4)],
      ["C", ramp(0.3, 4)],
    ]);
    const { mic, system } = onlineTracks(tracks, "B");
    expect(Array.from(mic)).toEqual(Array(4).fill(Math.fround(0.2)));
    expect(system[0]).toBeCloseTo(0.4, 6);
    expect(() => onlineTracks(tracks, "Z")).toThrow(/No track for Z/);
  });

  test("a gated track keeps its speaker's turns and nothing outside them", () => {
    const rate = 16_000;
    const gated = gateTurns(ramp(1, 5 * rate), [{ start: 2, end: 3 }], 0.25);
    expect(gated[Math.round(2.5 * rate)]).toBe(1);
    expect(gated[Math.round(1.6 * rate)]).toBe(0);
    expect(gated[Math.round(3.4 * rate)]).toBe(0);
    const fading = gated[Math.round(1.745 * rate)] as number;
    expect(fading).toBeGreaterThan(0);
    expect(fading).toBeLessThan(1);
  });
});

describe("TextGrid", () => {
  const grid = `File type = "ooTextFile"
Object class = "TextGrid"

xmin = 0
xmax = 100
tiers? <exists>
size = 2
item []:
	item [1]:
		class = "IntervalTier"
		name = "N_SPK1"
		xmin = 0
		xmax = 100
		intervals: size = 3
		intervals [1]:
			xmin = 1.5
			xmax = 4
			text = "你好，world。"
		intervals [2]:
			xmin = 5
			xmax = 6
			text = ""
		intervals [3]:
			xmin = 7
			xmax = 8
			text = "说 ""hi"""
	item [2]:
		class = "IntervalTier"
		name = "N_SPK2"
		xmin = 0
		xmax = 100
		intervals: size = 1
		intervals [1]:
			xmin = 10
			xmax = 12.5
			text = "嗯。"
`;

  test("gives each speaker's tier and its spoken intervals", () => {
    const tiers = parseTextGrid(grid);
    expect(tiers.map(speakerOf)).toEqual(["SPK1", "SPK2"]);
    expect(tiers[0]?.intervals).toEqual([
      { start: 1.5, end: 4, text: "你好，world。" },
      { start: 7, end: 8, text: '说 "hi"' },
    ]);
    expect(tiers[1]?.intervals).toEqual([{ start: 10, end: 12.5, text: "嗯。" }]);
  });
});

describe("AMI", () => {
  const text = [
    "AMI_ES2004b_H01_FEE013_0000500_0000700 HELLO THERE",
    "AMI_ES2004b_H00_MEO015_0000300_0000450 OKAY",
    "AMI_ES2004b_H01_FEE013_0000800_0001000 UM RIGHT",
    "AMI_IS1009a_H00_FIE088_0000100_0000200 OTHER MEETING",
    "AMI_ES2004b_H00_MEO015_0000450_0000460 ",
    "not an utterance",
  ].join("\n");

  test("reads Kaldi's utterances: who, when and what, and which file holds the audio", () => {
    const utterances = amiUtterances(text);
    expect(utterances).toHaveLength(4);
    expect(utterances[0]).toEqual({
      meeting: "ES2004b",
      headset: "01",
      speaker: "FEE013",
      start: 5,
      end: 7,
      text: "HELLO THERE",
      file: "ES2004b/eval_ami_es2004b_h01_fee013_0000500_0000700.wav",
    });
  });

  test("a meeting's utterances come in time order, with its speakers by talk time", () => {
    const meeting = ofMeeting(amiUtterances(text), "ES2004b");
    expect(meeting.map((u) => u.start)).toEqual([3, 5, 8]);
    expect(talkTimes(meeting)).toEqual([
      ["FEE013", 4],
      ["MEO015", 1.5],
    ]);
  });

  test("the reference is the utterances, each on the track of its speaker", () => {
    const meeting = ofMeeting(amiUtterances(text), "ES2004b");
    const reference = amiReference(meeting, (speaker) => (speaker === "MEO015" ? "mic" : "system"));
    expect(reference.segments.map((s) => [s.speaker, s.track])).toEqual([
      ["MEO015", "mic"],
      ["FEE013", "system"],
      ["FEE013", "system"],
    ]);
  });

  test("a participant's track holds their segments where they were said", async () => {
    const meeting = ofMeeting(amiUtterances(text), "ES2004b");
    const clip = (value: number) => floatWav(new Float32Array(1600).fill(value));
    const tar = gzipSync(
      tarOf([
        { name: "ES2004b/", data: new Uint8Array(0), type: "5" },
        { name: meeting[0]?.file as string, data: clip(0.5) },
        { name: meeting[1]?.file as string, data: clip(0.25) },
        { name: meeting[2]?.file as string, data: clip(0.125) },
        { name: "ES2004b/unwanted.wav", data: clip(1) },
      ]),
    );
    const path = join(folder, "ES2004b.tar.gz");
    await writeFile(path, tar);
    const { bySpeaker, length } = await headsetTracks(path, meeting);
    expect(length).toBe(Math.ceil((10 + 0.5) * 16_000));
    expect([...bySpeaker.keys()].sort()).toEqual(["FEE013", "MEO015"]);
    const fee = bySpeaker.get("FEE013") as Float32Array;
    expect(fee[5 * 16_000]).toBe(0.25);
    expect(fee[8 * 16_000 + 100]).toBe(0.125);
    expect(fee[4 * 16_000]).toBe(0);
    expect((bySpeaker.get("MEO015") as Float32Array)[3 * 16_000]).toBe(0.5);
  });

  test("a tar missing a segment is refused, naming it", async () => {
    const meeting = ofMeeting(amiUtterances(text), "ES2004b");
    const path = join(folder, "short.tar.gz");
    await writeFile(
      path,
      gzipSync(
        tarOf([{ name: meeting[0]?.file as string, data: floatWav(new Float32Array(160)) }]),
      ),
    );
    await expect(headsetTracks(path, meeting)).rejects.toThrow(/lacks 2 segments/);
  });
});

describe("Reading an archive until it has what it wants", () => {
  const far = pcmWav(Int16Array.from([1, 10, 100, 2, 20, 200, 3, 30, 300, 4, 40, 400]), 3);
  const near = pcmWav(Int16Array.from([5, 6, 7]));
  const archive = gzipSync(
    tarOf([
      { name: "Eval/far/R1_MS1.wav", data: far },
      { name: "Eval/far/R1.TextGrid", data: Buffer.from("a grid") },
      { name: "Eval/near/R1_N_SPK1.wav", data: near },
      { name: "Eval/near/never-reached.wav", data: randomBytes(400_000) },
    ]),
  );
  const wanted = [
    { name: "Eval/far/R1_MS1.wav", file: "R1.far.wav", keep: "first-channel" as const },
    { name: "Eval/far/R1.TextGrid", file: "R1.TextGrid", keep: "as-is" as const },
    { name: "Eval/near/R1_N_SPK1.wav", file: "R1_N_SPK1.wav", keep: "as-is" as const },
  ];

  function serving() {
    const state = { read: 0, requests: 0 };
    const fetchFn = (async () => {
      state.requests++;
      const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
          const at = state.read;
          if (at >= archive.length) return controller.close();
          state.read = Math.min(archive.length, at + 1024);
          controller.enqueue(archive.subarray(at, state.read));
        },
      });
      return new Response(body);
    }) as unknown as typeof fetch;
    return { state, fetchFn };
  }

  test("keeps the first channel as mono audio, the others as they are, and measures them", async () => {
    const { fetchFn, state } = serving();
    const measured = await extractEntries(
      fetchFn,
      "https://example.test/Eval.tar.gz",
      wanted,
      folder,
      () => {},
    );
    expect(Array.from(monoSamples(await readFile(join(folder, "R1.far.wav"))))).toEqual(
      [1, 2, 3, 4].map((v) => v / 32768),
    );
    expect(await readFile(join(folder, "R1.TextGrid"), "utf8")).toBe("a grid");
    expect(measured[1]).toMatchObject({ sha256: sha256(Buffer.from("a grid")), bytes: 6 });
    expect(measured[0]?.sha256).toBe(sha256(far));
    expect(measured[0]?.keptSha256).toBe(sha256(await readFile(join(folder, "R1.far.wav"))));
    expect(state.read).toBeLessThan(archive.length);
  });

  test("with its pins, reads nothing again when everything is there, and nothing wrong is kept", async () => {
    const first = serving();
    const measured = await extractEntries(
      first.fetchFn,
      "https://example.test/a",
      wanted,
      folder,
      () => {},
    );
    const second = serving();
    await extractEntries(second.fetchFn, "https://example.test/a", measured, folder, () => {});
    expect(second.state.requests).toBe(0);

    const wrong = measured.map((entry) => ({ ...entry, sha256: "0".repeat(64) }));
    const elsewhere = await mkdtemp(join(tmpdir(), "incarnamind-meetings-test-"));
    try {
      await expect(
        extractEntries(serving().fetchFn, "https://example.test/a", wrong, elsewhere, () => {}),
      ).rejects.toThrow(/doesn't match its pinned SHA-256/);
      await expect(readFile(join(elsewhere, "R1.far.wav"))).rejects.toThrow();
    } finally {
      await rm(elsewhere, { recursive: true, force: true });
    }
  });

  test("an archive without a wanted file is an error naming it", async () => {
    const extra = [...wanted, { name: "Eval/nope.wav", file: "nope.wav", keep: "as-is" as const }];
    await expect(
      extractEntries(serving().fetchFn, "https://example.test/a", extra, folder, () => {}),
    ).rejects.toThrow(/lacks Eval\/nope\.wav/);
  });
});
