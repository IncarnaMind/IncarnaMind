/**
 * A Citation of a meeting's Transcript, checked again once the Transcript has a newer version
 * (#3762): a Transcript that only grew, lines added after the ones it had, stands as cited
 * (`grew`), so the card says nothing changed, in the Note and in a web page to share; any other
 * change to its lines is a change.
 */
import { parseHTML } from "linkedom";
import { describe, expect, test } from "vitest";
import { recheckCitation } from "../../src/core/answers/citations";
import { type Cue, transcriptUnits } from "../../src/core/documents/formats/vtt";
import { citationOf } from "../helpers/citations";
import { createTempDataFolder, startCore } from "../helpers/core";
import {
  addAndProcess,
  createSourceFolder,
  sha256,
  waitForProcessing,
  writeSourceFile,
} from "../helpers/documents";
import { connectToMind } from "../helpers/mindClient";
import { writeMind } from "../helpers/minds";

const cues: Cue[] = [
  { startMs: 0, endMs: 2000, text: "The launch is on Monday.", speaker: "Them" },
  { startMs: 2000, endMs: 4000, text: "The budget holds at one point two million.", speaker: "Me" },
];
const later: Cue = {
  startMs: 4000,
  endMs: 6000,
  text: "Press waits for the date.",
  speaker: "Them",
};

/** A Transcript's versions by their content hash, the one named `current` its version now. */
function transcript(versions: Record<string, Cue[]>, current: string) {
  const units = new Map(
    Object.entries(versions).map(([hash, each]) => [
      hash,
      transcriptUnits({ cues: each, gaps: [] }),
    ]),
  );
  return {
    currentVersion: () => current,
    documentName: () => "Transcript · Launch",
    pageTexts: (_documentId: string, version: string, from: number | null, to: number | null) =>
      (units.get(version) ?? []).filter(
        (unit) =>
          from === null ||
          to === null ||
          (unit.page !== null && unit.page >= from && unit.page <= to),
      ),
    passagesCovering: () => [
      { id: "passage", text: (units.get(current) ?? []).map((unit) => unit.text).join("\n") },
    ],
  };
}

const cited = {
  documentId: "transcript",
  contentHash: "cited",
  pageFrom: 1,
  pageTo: 1,
  quote: "The launch is on Monday.",
  location: { kind: "time" as const, from: 0, to: 2000, speaker: "Them" },
};

// protects=a Citation of a live Transcript stays as cited while the meeting only adds lines after it; fails_when=each new line of a recording makes every earlier Citation say its Document changed
test("a Transcript that only grew after its line was cited stands as cited", () => {
  const grown = transcript({ cited: cues, grown: [...cues, later] }, "grown");
  expect(recheckCitation(grown, cited)).toMatchObject({
    check: "found",
    contentHash: "grown",
    grew: true,
  });
  // Its own version, unchanged, says nothing of growing.
  expect(recheckCitation(transcript({ cited: cues }, "cited"), cited)).not.toHaveProperty("grew");
});

// protects=a real change to a Transcript's lines still counts as a change for its Citations; fails_when=an edited, split, relabelled or reordered Transcript passes for one that only grew
test.each([
  ["its line edited", [{ ...cues[0], text: "The launch is on Tuesday." } as Cue, cues[1] as Cue]],
  ["another line edited", [cues[0] as Cue, { ...cues[1], text: "The budget was cut." } as Cue]],
  [
    "its line split",
    [
      { startMs: 0, endMs: 1000, text: "The launch is", speaker: "Them" },
      { startMs: 1000, endMs: 2000, text: "on Monday.", speaker: "Them" },
      cues[1] as Cue,
    ],
  ],
  ["a speaker renamed in the file", [cues[0] as Cue, { ...cues[1], speaker: "Speaker 2" } as Cue]],
  ["a line dropped", [cues[0] as Cue, later]],
  [
    "a line put in before the last",
    [cues[0] as Cue, { ...later, startMs: 1500, endMs: 1900 }, cues[1] as Cue],
  ],
])("a Transcript with %s has changed", (_what, now) => {
  const result = recheckCitation(transcript({ cited: cues, now }, "now"), cited);
  expect(result.contentHash).toBe("now");
  expect(result).not.toHaveProperty("grew");
});

const vtt = (...lines: string[]) => `WEBVTT\n\n${lines.join("\n\n")}\n`;
const MONDAY = "00:00:00.000 --> 00:00:02.000\n<v Them>The launch is on Monday.";
const BUDGET = "00:00:02.000 --> 00:00:04.000\n<v Me>The budget holds at one point two million.";
const PRESS = "00:00:04.000 --> 00:00:06.000\n<v Them>Press waits for the date.";

describe("a web page to share of a Note citing a Transcript", { timeout: 60_000 }, () => {
  /** A Note citing the first line of a Transcript of two, and its card in the page shared now. */
  async function citedTranscript() {
    const sources = await createSourceFolder();
    const core = startCore(await createTempDataFolder());
    const name = "Launch call.vtt";
    const [document] = await addAndProcess(core, [
      await writeSourceFile(sources, name, vtt(MONDAY, BUDGET)),
    ]);
    if (!document) throw new Error("Nothing was added.");
    const mind = await core.createMind({ title: "Launch" });
    const client = await connectToMind(core, mind.id);
    writeMind(client, [
      {
        type: "paragraph",
        content: [
          { type: "text", text: "It is on Monday" },
          await citationOf(core, document, "The launch is on Monday."),
        ],
      },
    ]);
    await client.settled();
    const rewrite = async (contents: string) => {
      await writeSourceFile(sources, name, contents);
      await core.reconcileDocuments();
      const [processed] = await waitForProcessing(core, [document.id]);
      expect(processed?.contentHash).toBe(sha256(contents));
    };
    const card = async () => {
      const shared = await core.exportMind(mind.id, { format: "share-page" });
      return parseHTML(new TextDecoder().decode(shared.data)).document.getElementById("card-1");
    };
    return { core, rewrite, card };
  }

  // protects=a shared page of a Note citing a Transcript that only grew since, lines added after its own, says nothing changed, as the Note's card doesn't (#3762); fails_when=the page says the Document changed after it was cited because a meeting recorded more
  test("a Transcript that only grew says nothing changed", async () => {
    const { core, rewrite, card } = await citedTranscript();
    try {
      await rewrite(vtt(MONDAY, BUDGET, PRESS));
      const shown = await card();
      expect(shown?.classList.contains("check-found")).toBe(true);
      expect(shown?.querySelector("mark.quote")?.textContent).toBe("The launch is on Monday.");
      expect(shown?.querySelector(".card-verdict")).toBeNull();
    } finally {
      core.close();
    }
  });

  // protects=a shared page of a Note citing a Transcript whose lines changed, not only grew, still says the Document changed after it was cited (#3762); fails_when=a Transcript edited after it was cited passes for one that only grew
  test("a Transcript whose cited line changed says so", async () => {
    const { core, rewrite, card } = await citedTranscript();
    try {
      await rewrite(vtt(MONDAY.replace("Monday", "Tuesday"), BUDGET, PRESS));
      expect((await card())?.querySelector(".card-verdict")?.textContent).toBe(
        "The Document changed after this was cited.",
      );
    } finally {
      core.close();
    }
  });
});
