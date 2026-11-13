import { writeFile } from "node:fs/promises";
import { describe, expect, test } from "vitest";
import type { Cue } from "../../src/core/documents/formats/vtt";
import { writeVtt } from "../../src/core/documents/formats/vtt";
import type { Language } from "../../src/core/language";
import { changedSourceLines } from "../../src/shared/citations";
import { type MessageKey, type MessageParams, translate } from "../../src/shared/i18n";
import {
  askAndFinish,
  checkedResult,
  citationsIn,
  citingModel,
  setUpWithDocuments,
} from "../helpers/citations";
import { sha256, waitForDocuments, waitForProcessing } from "../helpers/documents";

/**
 * A Transcript cited by its time whose next version moves its words (#3041): the line on the card
 * and in the viewer says where the quote is now by its Speaker and time, that it is in another place
 * when it is said twice and neither at the cited time, and, when the line at its time is given to
 * another Speaker, what it said before this change: found, under the new name.
 */

const QUOTE = "The boat arrives on Monday.";

const vtt = (cues: Cue[]) => writeVtt({ cues, gaps: [] });

const at = (minutes: number, seconds = 0) => (minutes * 60 + seconds) * 1000;

const VERSION_1 = vtt([
  { startMs: 0, endMs: 2000, text: "We opened the meeting.", speaker: "Alex" },
  { startMs: at(12), endMs: at(12, 3), text: QUOTE, speaker: "Dana" },
  { startMs: at(12, 10), endMs: at(12, 12), text: "Thanks, that helps.", speaker: "Alex" },
]);

const in_ = (language: Language) => (key: MessageKey, params?: MessageParams) =>
  translate(language, key, params);

/** A Note's Citation of the line at 12:00, then the Transcript changed to `next`: the lines it gets. */
async function citedThenChanged(next: string) {
  const model = citingModel({
    query: "boat Monday",
    records: (passages) => [
      { marker: 1, passage: passages[0]?.id, location: "12:00", quote: QUOTE },
    ],
    answer: "The boat comes on Monday[^1].",
  });
  const setup = await setUpWithDocuments(model, [{ name: "Call.vtt", contents: VERSION_1 }]);
  const { core, client, mind, documents } = setup;
  const document = documents[0];
  if (!document?.path) throw new Error("Nothing was added.");
  const { answerId } = await askAndFinish(core, client, mind.id, "When does the boat arrive?");
  const [citation] = citationsIn(client, answerId);
  if (!citation) throw new Error("No Citation.");
  expect(citation).toMatchObject({
    check: "found",
    location: { kind: "time", from: at(12), speaker: "Dana" },
  });
  await writeFile(document.path, next);
  await core.reconcileDocuments();
  await waitForDocuments(core, (listed) =>
    expect(listed.find((each) => each.id === document.id)?.contentHash).toBe(sha256(next)),
  );
  await waitForProcessing(core, [document.id]);
  const asked = {
    mindId: null,
    documentId: document.id,
    quote: QUOTE,
    pageFrom: citation.pageFrom,
    pageTo: citation.pageTo,
    contentHash: citation.contentHash,
    location: citation.location,
  };
  const before = checkedResult(await core.recheckCitation(asked));
  const after = checkedResult(await core.recheckCitation({ ...asked, lookElsewhere: true }));
  const { elsewhere: _, ...check } = after;
  expect(check).toEqual(before);
  const live = (await core.listDocuments()).find((each) => each.id === document.id);
  const lines = (["en", "zh-CN"] as const).map(
    (language) =>
      changedSourceLines(true, citation, after, live, language, in_(language)).note?.quote,
  );
  return { before, lines };
}

describe("A Transcript Citation whose line moved in the new version (#3041)", {
  timeout: 60_000,
}, () => {
  // protects=the cited line said at another time by the same Speaker is said to be there, by its Speaker and time, in English and Chinese, while the check stays not found at the cited time; fails_when=the line says the quote is no longer in the new version, or names the wrong time or Speaker; no_claim=how a time is worded (tests/shared/locations.test.ts).
  test("the same line at a later time says where it is now", async () => {
    const { before, lines } = await citedThenChanged(
      vtt([
        { startMs: 0, endMs: 2000, text: "We opened the meeting.", speaker: "Alex" },
        { startMs: at(12), endMs: at(12, 3), text: "Let me check the schedule.", speaker: "Alex" },
        { startMs: at(12, 4), endMs: at(12, 7), text: QUOTE, speaker: "Dana" },
      ]),
    );
    expect(before).toMatchObject({ check: "not-found", checkReason: "quote-not-on-pages" });
    expect(lines).toEqual([
      "Its quote is now at Dana · 12:04.",
      "引文已移到新位置（Dana · 12:04）。",
    ]);
  });

  // protects=the cited line said twice in the new version, neither at the cited time, reads as in another place, with no one time named; fails_when=one of the two times is named, or the quote reads as no longer in the new version; no_claim=a line said once (above).
  test("the line said twice, neither at the cited time, is in another place", async () => {
    const { before, lines } = await citedThenChanged(
      vtt([
        { startMs: at(3), endMs: at(3, 3), text: QUOTE, speaker: "Alex" },
        { startMs: at(12), endMs: at(12, 3), text: "Let me check the schedule.", speaker: "Dana" },
        { startMs: at(20), endMs: at(20, 3), text: QUOTE, speaker: "Dana" },
      ]),
    );
    expect(before).toMatchObject({ check: "not-found", checkReason: "quote-not-on-pages" });
    expect(lines).toEqual([
      "Its quote is in another place in the new version.",
      "引文在新版本中换了位置。",
    ]);
  });

  // protects=the line at its cited time given to another Speaker stays found, and its line names the time under the new name, as before this change; fails_when=the check or the line about it changes; no_claim=how a Speaker is renamed (tests/core/transcriptCitation.test.ts).
  test("the line at its time given to another Speaker stays found, under the new name", async () => {
    const { before, lines } = await citedThenChanged(
      vtt([
        { startMs: 0, endMs: 2000, text: "We opened the meeting.", speaker: "Alex" },
        { startMs: at(12), endMs: at(12, 3), text: QUOTE, speaker: "Priya" },
        { startMs: at(12, 10), endMs: at(12, 12), text: "Thanks, that helps.", speaker: "Alex" },
      ]),
    );
    expect(before).toMatchObject({
      check: "found",
      location: { kind: "time", from: at(12), speaker: "Priya" },
    });
    expect(lines).toEqual([
      "Its quote is now at Priya · 12:00.",
      "引文已移到新位置（Priya · 12:00）。",
    ]);
  });
});
