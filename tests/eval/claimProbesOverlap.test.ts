import { describe, expect, test } from "vitest";
import {
  ALL_PROBES,
  BACKED_WRITE_REPLY,
  BACKED_WRITE_REQUEST,
  requestOf,
} from "../../eval/everyday/claimProbes";
import {
  CLAIM_CHECK_INSTRUCTIONS,
  DONE_BY_NOTE_CHANGE,
  REQUEST_DONE_INSTRUCTIONS,
  UNCHANGED_PART_RULE,
} from "../../src/core/answers/claimedChanges";

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
    expect(PROBE_TEXTS).toHaveLength(336);
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

const CLAIMS_INSTRUCTIONS = [
  CLAIM_CHECK_INSTRUCTIONS,
  DONE_BY_NOTE_CHANGE,
  UNCHANGED_PART_RULE,
].join("\n");

// Shared on 2026-11-12, when this list was made: probes mostly written from the instructions'
// own examples, which both arms of #2878's gate read alike. A run not listed here fails.
const KNOWN_IN_CLAIMS: readonly string[] = [
  "unmade-page-en reply: “done the summary is now on the page”",
  "unmade-note-en reply: “your summary is in q review now”",
  "unmade-new-en request: “in a new note”",
  "unmade-new-en reply: “here it is in a new note library summary”",
  "unmade-renamed-en request: “page to q summary”",
  "unmade-renamed-en reply: “i've renamed the page to q summary”",
  "unmade-page-zh reply: “总结已经放在页面里了”",
  "unmade-paragraph-zh reply: “第二段现在更清楚了”",
  "unmade-new-zh reply: “已在新的笔记中整理好总结”",
  "unmade-shorter-en reply: “the summary is now”",
  "document-created-en reply: “the page was created on march to track the project”",
  "document-replaced-en reply: “the new page replaces the version published in”",
  "document-revised-zh reply: “已经修改了摘要部分的实验结论”",
  "document-finished-zh reply: “这份总结已经完成于”",
  "check-marks-en reply: “some sentences are marked in the note”",
  "check-marks-zh reply: “有几句话在笔记里被标记”",
  "check-marks-zh reply: “引用不支持”",
  "unmade-marks-risks-zh reply: “已在笔记中标出”",
  "unmade-verified-rewrite-zh reply: “需要你自己核实”",
  "unmade-marks-reformat-zh reply: “并把它们改成了统一格式”",
  "unmade-failed-then-longer-zh reply: “前面一次修改没有生效”",
  "unmade-denial-rewrite-zh reply: “这次没有改动”",
  "unmade-denial-rewrite-zh reply: “之外的内容”",
  "check-marks-marked-zh reply: “已在笔记中标出”",
  "check-marks-marked-zh reply: “需要你自己核实”",
  "negation-earlier-zh reply: “这次没有改动”",
  "negation-earlier-zh reply: “之外的内容”",
  "negation-earlier-zh reply: “修改没有生效”",
  "negation-unconfirmed-zh reply: “我没有确认”",
  "negation-unconfirmed-zh reply: “需要你自己核”",
  "done-made-en request: “in a new note”",
  "done-made-en reply: “changes are listed under”",
  "done-unmade-en reply: “changes are listed under”",
  "partial-same-note-en reply: “changes are listed under”",
  "partial-other-note-en reply: “changes are listed under”",
  "partial-stopped-en reply: “changes are listed under”",
  "partial-command-en reply: “changes are listed under”",
  "backed-rename-command-en request: “page to q summary”",
  "backed-rename-command-en reply: “i've renamed the page to q summary”",
  "backed write request: “a risks section to q review”",
  "backed write reply: “i added a risks section to q review”",
];

describe("the claims check's instructions", () => {
  test("share no run of words with a probe's request or reply beyond those known", () => {
    expect(
      sharedWith(CLAIMS_INSTRUCTIONS, PROBE_TEXTS).filter((run) => !KNOWN_IN_CLAIMS.includes(run)),
    ).toEqual([]);
  });
});
