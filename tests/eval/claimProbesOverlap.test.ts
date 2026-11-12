import { describe, expect, test } from "vitest";
import {
  ALL_PROBES,
  BACKED_WRITE_REPLY,
  BACKED_WRITE_REQUEST,
  requestOf,
} from "../../eval/everyday/claimProbes";
import { REQUEST_DONE_INSTRUCTIONS } from "../../src/core/answers/claimedChanges";

// Instructions that hold a probe's own words help that probe answer itself (#2878), so the
// question's instructions share no four English words or five Chinese characters in a row with
// any probe's request or reply, dev or held out.
const WORDS = 4;
const CHARACTERS = 5;

interface ProbeText {
  probe: string;
  text: string;
}

const wordsOf = (text: string) => text.toLocaleLowerCase("en").match(/[a-z']+/g) ?? [];
const hanSpansOf = (text: string) =>
  (text.match(/\p{Script=Han}+/gu) ?? []).map((span) => Array.from(span));

const windows = (units: readonly string[], size: number, glue: string) =>
  units
    .slice(0, Math.max(0, units.length - size + 1))
    .map((_, at) => units.slice(at, at + size).join(glue));

function stretches(units: readonly string[], size: number, glue: string, held: Set<string>) {
  const covered = units.map(() => false);
  windows(units, size, glue).forEach((run, at) => {
    if (held.has(run)) covered.fill(true, at, at + size);
  });
  const found: string[] = [];
  let start = -1;
  covered.concat(false).forEach((shared, at) => {
    if (shared && start < 0) start = at;
    if (!shared && start >= 0) {
      found.push(units.slice(start, at).join(glue));
      start = -1;
    }
  });
  return found;
}

function sharedWith(instructions: string, texts: readonly ProbeText[]): string[] {
  const words = new Set(windows(wordsOf(instructions), WORDS, " "));
  const characters = new Set(
    hanSpansOf(instructions).flatMap((span) => windows(span, CHARACTERS, "")),
  );
  return texts.flatMap(({ probe, text }) =>
    [
      ...stretches(wordsOf(text), WORDS, " ", words),
      ...hanSpansOf(text).flatMap((span) => stretches(span, CHARACTERS, "", characters)),
    ].map((stretch) => `${probe}: “${stretch}”`),
  );
}

const PROBE_TEXTS: ProbeText[] = [
  ...ALL_PROBES.flatMap((probe) => [
    { probe: `${probe.id} request`, text: requestOf(probe.id) },
    { probe: `${probe.id} reply`, text: probe.reply },
  ]),
  { probe: "backed write request", text: BACKED_WRITE_REQUEST },
  { probe: "backed write reply", text: BACKED_WRITE_REPLY },
];

describe("the instructions of whether a reply says the request is done", () => {
  test("share no run of words with any probe's request or reply", () => {
    expect(PROBE_TEXTS).toHaveLength(302);
    expect(sharedWith(REQUEST_DONE_INSTRUCTIONS, PROBE_TEXTS)).toEqual([]);
  });

  test("a shared run is named whole, with the probe whose text holds it", () => {
    const texts = [
      { probe: "done-unmade-zh reply", text: "已经全部完成，改动都列在回复下方。" },
      {
        probe: "done-unmade-en reply",
        text: "All finished: the changes are listed under this reply.",
      },
      { probe: "dev-answer-en reply", text: "The lease ends on 31 March." },
    ];
    expect(
      sharedWith(
        "或改动已经做好、列在回复下方。A sentence that says its changes are listed under the reply.",
        texts,
      ),
    ).toEqual([
      "done-unmade-zh reply: “列在回复下方”",
      "done-unmade-en reply: “changes are listed under”",
    ]);
  });
});
