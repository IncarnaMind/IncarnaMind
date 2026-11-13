/**
 * A call-help reply asked in the form whose facts stand apart (#2847), as its reader reads it: what
 * each line is, the words kept, the markers that come off and the places of those that stay.
 */
import { describe, expect, test } from "vitest";
import type { AnswerStatus } from "../../src/core/api";
import { citedSentences } from "../../src/shared/citedSentences";
import {
  type HelpLayout,
  helpLayout,
  helpReplyRead,
  type ReplyItem,
  type ReplyPiece,
} from "../../src/shared/helpReplyRead";
import type { MeetingHelpKind } from "../../src/shared/meetingHelp";

const layoutOf = (kind: MeetingHelpKind, status: AnswerStatus = "done"): HelpLayout =>
  helpLayout(kind, { status, textBehind: false, form: "fact lines" });

const textOf = (pieces: readonly ReplyPiece[]) =>
  pieces
    .map((piece) =>
      piece.kind === "text"
        ? piece.text
        : piece.kind === "citation"
          ? `[${piece.marker}@${piece.at}]`
          : `[=${piece.marker}]`,
    )
    .join("")
    .trim();

/** The panel's lines for an item: what to say, its facts, its own lines and its "→". */
const panelOf = (items: readonly ReplyItem[]) =>
  items.flatMap((item) => [
    textOf(item.lead),
    ...item.notes.map((note) => `  fact: ${textOf(note)}`),
    ...item.own.map((line) => `  own: ${textOf(line)}`),
    ...(item.effect ? [`→ ${textOf(item.effect)}`] : []),
  ]);

const read = (kind: MeetingHelpKind, reply: string, status: AnswerStatus = "done") =>
  helpReplyRead(reply, layoutOf(kind, status));

describe("an option whose facts stand apart", () => {
  // protects=the line to say keeps its words and loses its markers, each fact line keeps its words and markers without its "> ", the "→" line loses its markers, in English and Chinese; each line's kind is given beside the text; fails_when=a line to say keeps a chip, a fact loses one, a mark stays in the text, or a kind is wrong; no_claim=what the check finds.
  test.each([
    {
      language: "English",
      reply:
        "★ We can't go below list, but we can add a free sandbox [^1]\n> Every Enterprise plan includes a test sandbox at no charge [^2]\n→ keeps the deal moving [^3]",
      text: "★ We can't go below list, but we can add a free sandbox\nEvery Enterprise plan includes a test sandbox at no charge [^2]\n→ keeps the deal moving",
      panel: [
        "We can't go below list, but we can add a free sandbox",
        "  fact: Every Enterprise plan includes a test sandbox at no charge [2@1]",
        "→ keeps the deal moving",
      ],
    },
    {
      language: "Chinese",
      reply:
        "★ 价格没法再低，但可以免费开一个沙盒 [^1]\n＞ 每个企业版套餐都免费含一个测试沙盒 [^2]\n→ 推进成交",
      text: "★ 价格没法再低，但可以免费开一个沙盒\n每个企业版套餐都免费含一个测试沙盒 [^2]\n→ 推进成交",
      panel: [
        "价格没法再低，但可以免费开一个沙盒",
        "  fact: 每个企业版套餐都免费含一个测试沙盒 [2@1]",
        "→ 推进成交",
      ],
    },
  ])("in $language", ({ reply, text, panel }) => {
    const reading = read("answer", reply);
    expect(reading.text).toBe(text);
    expect(reading.kinds).toEqual(["say", "fact", "effect"]);
    expect(panelOf(reading.options)).toEqual(panel);
    expect(reading.options[0]?.said).toBe(true);
  });

  // protects=an option shows no more than two fact lines, its third left out of the panel but kept in the text with its marker for the check, and one with none shows no source; fails_when=the panel shows three facts, or the third's marker is lost; no_claim=how often a model writes three.
  test.each([0, 1, 2, 3])("with %i fact lines", (count) => {
    const facts = [
      "Panels carry a 25-year warranty [^1]",
      "Inverters are covered for 10 years [^2]",
      "Workmanship is guaranteed for 5 years [^3]",
    ].slice(0, count);
    const reply = [
      "★ Yes, it's all covered",
      ...facts.map((fact) => `> ${fact}`),
      "→ answers the worry",
    ].join("\n");
    const reading = read("answer", reply);
    expect(reading.text).toBe(
      ["★ Yes, it's all covered", ...facts, "→ answers the worry"].join("\n"),
    );
    expect(reading.options[0]?.notes).toHaveLength(Math.min(count, 2));
    expect(citedSentences(reading.text).flatMap((each) => each.markers)).toEqual(
      [1, 2, 3].slice(0, count),
    );
    expect(reading.kinds).toEqual(["say", ...facts.map(() => "fact"), "effect"]);
  });

  // protects=the reply's own line in an option, for what neither the Documents nor the call says, loses its mark and any marker and is its own line, apart from the facts; a fact line with no marker is the reply's own too, as it is read again from the text kept; fails_when=an own line cites, shows as a fact, or reads otherwise once kept; no_claim=how it looks.
  test("an own line, and a fact line with no marker", () => {
    const reply =
      "★ We work days; I'll ask about nights\n> Installers work Monday to Saturday, 7 am to 5 pm [^1]\n= The Documents don't say whether night work is possible [^1]\n> Nights are possible\n→ honest about it";
    const reading = read("answer", reply);
    expect(reading.text).toBe(
      "★ We work days; I'll ask about nights\nInstallers work Monday to Saturday, 7 am to 5 pm [^1]\nThe Documents don't say whether night work is possible\nNights are possible\n→ honest about it",
    );
    expect(reading.kinds).toEqual(["say", "fact", "own", "own", "effect"]);
    expect(panelOf(reading.options)).toEqual([
      "We work days; I'll ask about nights",
      "  fact: Installers work Monday to Saturday, 7 am to 5 pm [1@0]",
      "  own: The Documents don't say whether night work is possible",
      "  own: Nights are possible",
      "→ honest about it",
    ]);
  });

  // protects=a fact line the model began with a list's mark or none, inside an option, is a fact line, not a new item; fails_when=it splits the option or keeps its mark; no_claim=how often a model does it.
  test.each(["- ", "• ", "* ", ""])("a fact line begun with %j", (mark) => {
    const reply = `★ Yes, it's covered\n${mark}Panels carry a 25-year warranty [^1]\n→ answers the worry`;
    const reading = read("answer", reply);
    expect(reading.text).toBe(
      "★ Yes, it's covered\nPanels carry a 25-year warranty [^1]\n→ answers the worry",
    );
    expect(reading.kinds).toEqual(["say", "fact", "effect"]);
  });

  // protects=a fact line written after its option's "→" line goes into that option above its "→" in the text kept, so the text reads the same again, and its marker keeps its place as written; a fact line written before the first option goes into the first; the next option is whole; fails_when=the late fact starts an option of its own or the next option takes it, or a place moves; no_claim=how often a model writes it so.
  test("a fact written outside its option goes into the option it belongs to", () => {
    const reply = [
      "> Every roof is surveyed first [^1]",
      "★ We'll survey each roof",
      "→ moves to a survey",
      "> A survey takes two hours [^2]",
      "",
      "Shall we book the surveys this week? [^3]",
      "> A survey costs nothing [^4]",
      "→ books a date",
    ].join("\n");
    const reading = read("ask", reply);
    expect(reading.text).toBe(
      [
        "★ We'll survey each roof",
        "Every roof is surveyed first [^1]",
        "A survey takes two hours [^2]",
        "→ moves to a survey",
        "",
        "Shall we book the surveys this week?",
        "A survey costs nothing [^4]",
        "→ books a date",
      ].join("\n"),
    );
    expect(panelOf(reading.options)).toEqual([
      "We'll survey each roof",
      "  fact: Every roof is surveyed first [1@0]",
      "  fact: A survey takes two hours [2@1]",
      "→ moves to a survey",
      "Shall we book the surveys this week?",
      "  fact: A survey costs nothing [4@3]",
      "→ books a date",
    ]);
    const again = read("ask", reading.text);
    expect(again.text).toBe(reading.text);
    expect(again.kinds).toEqual(reading.kinds);
  });
});

describe("short lines whose facts stand apart", () => {
  // protects=the check button's reply is its verdict, the reply's own line with no marker, then what they said and what the Documents say, each a fact line with its marker, kept as a list's lines with no "> " or "= ", in English and Chinese; the panel shows its three lines; fails_when=a mark stays, the verdict cites, or a fact loses its marker; no_claim=whether the verdict is right.
  test.each([
    {
      reply:
        "= Wrong. [^1]\n> They said backups run every twelve hours [^1]\n> Backups run every eight hours [^2]",
      text: "- Wrong.\n- They said backups run every twelve hours [^1]\n- Backups run every eight hours [^2]",
    },
    {
      reply: "＝ 不对。\n＞ 对方说每十二小时备份一次 [^1]\n＞ 每八小时备份一次 [^2]",
      text: "- 不对。\n- 对方说每十二小时备份一次 [^1]\n- 每八小时备份一次 [^2]",
    },
  ])("the check button: $text", ({ reply, text }) => {
    const reading = read("check", reply);
    expect(reading.text).toBe(text);
    expect(reading.kinds).toEqual(["own", "fact", "fact"]);
    expect(reading.options).toHaveLength(3);
  });

  // protects=one claim a press: a reply checking two claims shows the newest's three lines and no more, as the panel shows three short lines; fails_when=a fourth line shows; no_claim=which claim a model checks.
  test("a reply that checks two claims shows three lines", () => {
    const reply = [
      "= Wrong.",
      "> They said backups run every twelve hours [^1]",
      "> Backups run every eight hours [^2]",
      "= Right.",
      "> They said restores take a day [^3]",
      "> A restore takes a day [^4]",
    ].join("\n");
    expect(read("check", reply).options).toHaveLength(3);
  });

  // protects=a sum's lines in the form keep their markers on facts and drop none from an own remark that never had one; an unmarked line is a model's note, left out as today; fails_when=a fact loses its marker or a note shows; no_claim=what the check finds.
  test("a sum, with a model's note above it", () => {
    const reply =
      "Here is the summary.\n> The launch moves to 18 November [^1]\n= No one has said who tells support";
    const reading = read("sum", reply);
    expect(reading.text).toBe(
      "Here is the summary.\n- The launch moves to 18 November [^1]\n- No one has said who tells support",
    );
    expect(reading.kinds).toEqual(["other", "fact", "own"]);
    expect(reading.options.map((item) => textOf(item.lead))).toEqual([
      "The launch moves to 18 November [1@0]",
      "No one has said who tells support",
    ]);
  });
});

describe("a reply still written, or stopped halfway", () => {
  // protects=while a reply in the form streams, a marker on its line to say never shows, a line that is only a mark shows nothing, and once it ends no marker shown is gone; stopped halfway, it reads as it was then; fails_when=a chip flashes on a line to say, or a "> " shows as a line; no_claim=how long it takes.
  test.each<AnswerStatus>(["streaming", "stopped"])("%s", (status) => {
    const reply =
      "★ We can add a free sandbox [^1]\n> Every Enterprise plan includes a test sandbox [^2]\n→ keeps the deal moving\n\nLet me check with the team\n= The Documents don't say whether the price includes customs duty\n→ buys time";
    const whole = read("answer", reply);
    for (let end = 1; end <= reply.length; end++) {
      const part = read("answer", reply.slice(0, end), status);
      const says = part.options.flatMap((item) => item.lead);
      expect(says.some((piece) => piece.kind === "citation")).toBe(false);
      expect(part.text.split("\n").some((line) => /^[>＞=＝]/.test(line.trim()))).toBe(false);
    }
    expect(read("answer", reply, status).text).toBe(whole.text);
  });
});

describe("main's form reads exactly as today", () => {
  // protects=a reply with no "> " or "= " line, read in today's layout, keeps every line, mark and marker as #3046 read it but for the "→" rule, its kinds say what each line is, and no line is the reply's own; fails_when=a line or item changes, or an own line appears; no_claim=how the form reads.
  test.each([
    [
      "answer",
      "★ Yes, Enterprise is $45 a seat [^1]\n→ answers at once\n\nI'll confirm it today [^1]\n→ buys time",
      ["say", "effect", "other", "say", "effect"],
    ],
    [
      "want",
      "★ They want the total\n12:04 “our budget stops at ten” [^1]\n→ give the tier",
      ["reading", "fact", "effect"],
    ],
    ["sum", "- The launch moves to 18 November [^1]\n- Dana confirms the date", ["short", "short"]],
  ] as const)("%s", (kind, reply, kinds) => {
    const reading = helpReplyRead(reply, helpLayout(kind, { status: "done", textBehind: false }));
    expect(reading.text).toBe(reply);
    expect(reading.kinds).toEqual(kinds);
    expect(reading.options.every((item) => item.own.length === 0)).toBe(true);
  });
});

describe('"Am I leading them?" keeps main\'s reading in the form', () => {
  // protects=its first line, the answer to whether the question leads, stays as written with its marker, before options read in the form; fails_when=the line put first loses a marker or is read as an option; no_claim=what the model says.
  test("its line put first", () => {
    const reply =
      "Yes: “you'd agree it's slow, right” suggests the answer [^1]\n★ What slows you down most?\n→ open question";
    const reading = helpReplyRead(
      reply,
      helpLayout("leading", { status: "done", textBehind: false, form: "fact lines" }),
    );
    expect(reading.text).toBe(reply);
    expect(reading.kinds).toEqual(["lead-in", "say", "effect"]);
  });
});
