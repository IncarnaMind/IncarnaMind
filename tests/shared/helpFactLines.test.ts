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

  // protects=an option shows every fact line it holds, each kept in the text with its marker for the check, so a turned line is never hidden behind the model's own two, and one with none shows no source; fails_when=a fact line is left out of the panel, or a marker is lost; no_claim=how often a model writes three.
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
    expect(reading.options[0]?.notes).toHaveLength(count);
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
});

/** The panel's lines for a whole reply: its opening fact lines, its options and its closing line. */
const wholeOf = (reading: ReturnType<typeof read>) => [
  ...reading.opening.map((line) => `opening: ${textOf(line)}`),
  ...panelOf(reading.options),
  ...reading.closing.map((line) => `closing: ${textOf(line)}`),
];

/** Reads `reply` again from the text kept, as every later reader does, and expects it read the same. */
function readsTheSameAgain(kind: MeetingHelpKind, reply: string, status: AnswerStatus = "done") {
  const reading = read(kind, reply, status);
  const again = read(kind, reading.text, status);
  expect(again.text).toBe(reading.text);
  expect(again.kinds).toEqual(reading.kinds);
  expect(wholeOf(again)).toEqual(wholeOf(reading));
  return reading;
}

describe("the text kept keeps the model's order (#2847)", () => {
  const CLOSING = {
    English: {
      reply: [
        "★ We can add a free sandbox",
        "> Every Enterprise plan includes a test sandbox at no charge [^1]",
        "→ keeps the deal moving",
        "",
        "Let me check the price with the team",
        "→ buys time",
        "",
        "= The Documents don't say whether the price includes customs duty",
      ].join("\n"),
      closing: "The Documents don't say whether the price includes customs duty",
    },
    Chinese: {
      reply: [
        "★ 可以免费开一个沙盒",
        "＞ 每个企业版套餐都免费含一个测试沙盒 [^1]",
        "→ 推进成交",
        "",
        "我跟团队确认一下价格",
        "→ 争取时间",
        "",
        "＝ 文档没有提到价格是否含关税",
      ].join("\n"),
      closing: "文档没有提到价格是否含关税",
    },
  };

  // protects=the reply's own line after its options is its closing line, drawn after them and in no option, a paragraph of its own in the text kept, which reads the same again, in English and Chinese, whether a blank line comes before it or not; fails_when=it goes into the last option, its words change, or a second reading reads it otherwise; no_claim=how the panel lays it out.
  test.each(["English", "Chinese"] as const)(
    "in %s, the closing line stays after the options",
    (language) => {
      const { reply, closing } = CLOSING[language];
      for (const written of [reply, reply.replace(/\n\n(?=[=＝])/, "\n")]) {
        const reading = readsTheSameAgain("answer", written);
        expect(reading.closing.map(textOf)).toEqual([closing]);
        expect(reading.options).toHaveLength(2);
        expect(
          reading.options.every((item) => item.own.length === 0 && item.after.length === 0),
        ).toBe(true);
        expect(reading.text.endsWith(`\n\n${closing}`)).toBe(true);
        expect(reading.kinds.at(-1)).toBe("own");
      }
    },
  );

  // protects=while the reply is written, its closing line shows after the options as soon as its "= " is written, never inside an option, and a half-written mark shows nothing; stopped halfway it reads as it was, and once it ends nothing it showed moves, in English and Chinese; fails_when=the line shows in an option, a lone "=" shows, or the closing line moves when the reply ends or stops; no_claim=how long it takes.
  test.each(["English", "Chinese"] as const)(
    "in %s, the closing line while written and stopped",
    (language) => {
      const { reply, closing } = CLOSING[language];
      const markAt = reply.search(/[=＝] /u);
      for (let end = 1; end <= reply.length; end++) {
        const part = read("answer", reply.slice(0, end), "streaming");
        const inOptions = part.options.flatMap((item) => [...item.own, ...item.after]).map(textOf);
        expect(inOptions.some((line) => line !== "" && closing.startsWith(line))).toBe(false);
        expect(part.closing.length).toBe(end > markAt + 2 ? 1 : 0);
        expect(part.text.split("\n").some((line) => /^[>＞=＝]/.test(line.trim()))).toBe(false);
      }
      const stopped = readsTheSameAgain("answer", reply, "stopped");
      expect(stopped.closing.map(textOf)).toEqual([closing]);
      expect(wholeOf(stopped)).toEqual(wholeOf(read("answer", reply)));
    },
  );

  // protects=a fact line written after an option's "→" line stays where written, right after it, and belongs to the option above: shown under it with its chip at its place as written, kept in that option's paragraph whether or not a blank line came between, while the next option is whole, in English and Chinese; fails_when=the fact moves above the "→" line, starts an option of its own, joins the next option or the closing line, or a place moves; no_claim=how often a model writes it so.
  test.each([
    {
      language: "English",
      reply: [
        "★ We'll survey each roof",
        "→ moves to a survey",
        "",
        "> A survey takes two hours [^1]",
        "",
        "Shall we book the surveys this week?",
        "> A survey costs nothing [^2]",
        "→ books a date",
      ].join("\n"),
      text: [
        "★ We'll survey each roof",
        "→ moves to a survey",
        "A survey takes two hours [^1]",
        "",
        "Shall we book the surveys this week?",
        "A survey costs nothing [^2]",
        "→ books a date",
      ].join("\n"),
      panel: [
        "We'll survey each roof",
        "→ moves to a survey",
        "  after: A survey takes two hours [1@0]",
        "Shall we book the surveys this week?",
        "  fact: A survey costs nothing [2@1]",
        "→ books a date",
      ],
    },
    {
      language: "Chinese",
      reply: [
        "★ 我们会先勘察每个屋顶",
        "→ 推进到勘察",
        "＞ 一次勘察需要两个小时 [^1]",
        "",
        "这周就约勘察吧？",
        "＞ 勘察不收费 [^2]",
        "→ 定下日期",
      ].join("\n"),
      text: [
        "★ 我们会先勘察每个屋顶",
        "→ 推进到勘察",
        "一次勘察需要两个小时 [^1]",
        "",
        "这周就约勘察吧？",
        "勘察不收费 [^2]",
        "→ 定下日期",
      ].join("\n"),
      panel: [
        "我们会先勘察每个屋顶",
        "→ 推进到勘察",
        "  after: 一次勘察需要两个小时 [1@0]",
        "这周就约勘察吧？",
        "  fact: 勘察不收费 [2@1]",
        "→ 定下日期",
      ],
    },
  ])(
    "in $language, a fact line after its option's → line belongs to it",
    ({ reply, text, panel }) => {
      const reading = readsTheSameAgain("ask", reply);
      expect(reading.text).toBe(text);
      const shown = reading.options.flatMap((item) => [
        ...panelOf([{ ...item, effect: null }]),
        ...(item.effect ? [`→ ${textOf(item.effect)}`] : []),
        ...item.after.map((line) => `  after: ${textOf(line)}`),
      ]);
      expect(shown).toEqual(panel);
      expect(reading.kinds).toEqual(["say", "effect", "fact", "other", "say", "fact", "effect"]);
      expect(reading.closing).toEqual([]);
    },
  );

  // protects=an own line written between two options belongs to the option above, after its "→" line, and the next option is whole; fails_when=it becomes the closing line, joins the next option, or starts one; no_claim=how often a model writes it so.
  test("an own line between options belongs to the option above", () => {
    const reply = [
      "★ We'll survey each roof",
      "→ moves to a survey",
      "= The Documents don't say how long the survey report takes",
      "",
      "Shall we book the surveys this week?",
      "→ books a date",
    ].join("\n");
    const reading = readsTheSameAgain("ask", reply);
    expect(reading.options[0]?.after.map(textOf)).toEqual([
      "The Documents don't say how long the survey report takes",
    ]);
    expect(
      reading.options[1]?.lead.map((piece) => (piece.kind === "text" ? piece.text : "")),
    ).toEqual(["Shall we book the surveys this week?"]);
    expect(reading.closing).toEqual([]);
  });

  // protects=reading A of the ruling: a fact line written before the first line to say belongs to no option; it stays first, with its chip at its place, as a paragraph of its own in the text kept, and while the reply is written it shows from the moment its marker is written and doesn't move when "★" begins or the reply ends, in English and Chinese; fails_when=it goes into the first option, hides, or moves; no_claim=how often a model writes it so.
  test.each([
    {
      language: "English",
      reply:
        "> Every roof is surveyed before a quote [^1]\n★ We'll survey each roof first\n→ moves to a survey\n\nShall we book it this week?\n→ books a date",
      opening: "Every roof is surveyed before a quote [1@0]",
    },
    {
      language: "Chinese",
      reply:
        "＞ 报价前每个屋顶都要先勘察 [^1]\n★ 我们会先勘察每个屋顶\n→ 推进到勘察\n\n这周就约吧？\n→ 定下日期",
      opening: "报价前每个屋顶都要先勘察 [1@0]",
    },
  ])(
    "in $language, a fact line before the first line to say stands apart",
    ({ reply, opening }) => {
      const reading = readsTheSameAgain("answer", reply);
      expect(reading.opening.map(textOf)).toEqual([opening]);
      expect(reading.options).toHaveLength(2);
      expect(reading.options[0]?.notes).toEqual([]);
      expect(reading.text.startsWith(`${opening.replace(" [1@0]", " [^1]")}\n\n★`)).toBe(true);
      expect(reading.kinds.slice(0, 3)).toEqual(["fact", "other", "say"]);
      const markerEnd = reply.indexOf("]") + 1;
      for (let end = 1; end <= reply.length; end++) {
        const part = read("answer", reply.slice(0, end), "streaming");
        expect(part.opening.map(textOf)).toEqual(end >= markerEnd ? [opening] : []);
        expect(part.options.every((item) => item.notes.length === 0)).toBe(true);
      }
    },
  );

  // protects=a reply whose last option never had its "→" line reads that line, once the reply has ended or stopped, as the reply's closing line, as its text kept can only read again; while written it is an option still coming; fails_when=it reads otherwise the second time; no_claim=how often a model leaves out a "→" line.
  test("a last option with no → line is the closing line once the reply ends", () => {
    const reply =
      "★ We can add a free sandbox\n→ keeps the deal moving\n\nLet me check with the team";
    expect(read("answer", reply, "streaming").options).toHaveLength(2);
    for (const status of ["done", "stopped"] as const) {
      const reading = readsTheSameAgain("answer", reply, status);
      expect(reading.options).toHaveLength(1);
      expect(reading.closing.map(textOf)).toEqual(["Let me check with the team"]);
    }
  });
});

describe("short lines whose facts stand apart", () => {
  // protects=a short-lines reply in the form is its fact lines, each with its marker, and the reply's own lines with no marker, kept as a list's lines with no "> " or "= ", in English and Chinese; the panel shows its three lines; fails_when=a mark stays, an own line cites, or a fact loses its marker; no_claim=what the check finds.
  test.each([
    {
      reply:
        "= No one has said who tells support [^1]\n> The launch moves to 18 November [^1]\n> Dana confirms the date with the provider [^2]",
      text: "- No one has said who tells support\n- The launch moves to 18 November [^1]\n- Dana confirms the date with the provider [^2]",
    },
    {
      reply:
        "＝ 还没人说由谁通知客服\n＞ 上线推迟到 11 月 18 日 [^1]\n＞ Dana 跟服务商确认日期 [^2]",
      text: "- 还没人说由谁通知客服\n- 上线推迟到 11 月 18 日 [^1]\n- Dana 跟服务商确认日期 [^2]",
    },
  ])("the facts button: $text", ({ reply, text }) => {
    const reading = read("facts", reply);
    expect(reading.text).toBe(text);
    expect(reading.kinds).toEqual(["own", "fact", "fact"]);
    expect(reading.options).toHaveLength(3);
  });

  // protects=a short-lines reply shows three lines and no more, as the panel shows three short lines; fails_when=a fourth line shows; no_claim=how many a model writes.
  test("a short-lines reply of four lines shows three", () => {
    const reply = [
      "> The launch moves to 18 November [^1]",
      "> Dana confirms the date with the provider [^2]",
      "> Marketing waits for the new date [^3]",
      "= No one has said who tells support",
    ].join("\n");
    expect(read("facts", reply).options).toHaveLength(3);
  });

  // protects=the Check button's reply is read as on main in the form, its marks, markers and "→" line included, since Check is asked as on main (#2847); fails_when=the form takes a mark or a marker off a Check reply, or reads its lines otherwise than main; no_claim=whether its verdict is right.
  test.each([
    "- They said backups run every twelve hours [^1]\n- Supported: backups run every eight hours [^2]\n→ Ask which plan they mean [^2]",
    "- 对方说每十二小时备份一次 [^1]\n- 文档说每八小时备份一次 [^2]\n→ 问清对方说的是哪个套餐 [^2]",
    "= Wrong.\n> They said backups run every twelve hours [^1]",
  ])("the Check button is read as on main: %s", (reply) => {
    const inForm = read("check", reply);
    const asToday = helpReplyRead(
      reply,
      helpLayout("check", { status: "done", textBehind: false }),
    );
    expect(inForm.text).toBe(asToday.text);
    expect(inForm.options).toEqual(asToday.options);
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

describe("a Document's Citation on a line to say becomes a fact line of its own (#2847)", () => {
  /** A reply read with these recorded Document Citations' quotes, by marker. */
  const readWith = (
    kind: MeetingHelpKind,
    reply: string,
    quotes: Record<number, string>,
    status: AnswerStatus = "done",
  ) =>
    helpReplyRead(reply, {
      ...layoutOf(kind, status),
      quoteOf: (marker) => quotes[marker] ?? null,
    });
  /** An option's lines as the panel shows them: to say, facts (a turned line the last), own, "→". */
  const optionOf = (item: ReplyItem | undefined) =>
    item
      ? [
          textOf(item.lead),
          ...item.notes.map((line) => `  fact: ${textOf(line)}`),
          ...item.own.map((line) => `  own: ${textOf(line)}`),
          ...(item.effect ? [`→ ${textOf(item.effect)}`] : []),
        ]
      : [];
  /** Reads `reply`, then its text kept again with the same quotes: the same words, kinds and lines. */
  function turnedTwice(kind: MeetingHelpKind, reply: string, quotes: Record<number, string>) {
    const reading = readWith(kind, reply, quotes);
    const again = readWith(kind, reading.text, quotes);
    expect(again.text).toBe(reading.text);
    expect(again.kinds).toEqual(reading.kinds);
    const words = (each: typeof reading) =>
      each.options.map((item) => optionOf(item).map((line) => line.replace(/ \[\d+@\d+\]/g, "")));
    expect(words(again)).toEqual(words(reading));
    return { reading, again };
  }

  // protects=a Document's Citation left on an option's line to say is a fact line of its quoted words, its closing full stop off, after the option's own fact line and above its "→" line, with its chip, while the line to say shows none; read again from the text kept, it is the same turned line, always shown, in English and Chinese; fails_when=the Citation stays on the line to say, is dropped, the line goes elsewhere, or a second reading reads it otherwise; no_claim=how often a model leaves a Citation on a line to say.
  test.each([
    {
      language: "English",
      reply:
        "★ Yes, it's all covered [^1]\n> Inverters are covered for 10 years [^2]\n→ answers the worry",
      quotes: { 1: "Panels carry a 25-year warranty.", 2: "Inverters are covered for 10 years." },
      text: "★ Yes, it's all covered\nInverters are covered for 10 years [^2]\nPanels carry a 25-year warranty [^1]\n→ answers the worry",
      option: [
        "Yes, it's all covered",
        "  fact: Inverters are covered for 10 years [2@0]",
        "  fact: Panels carry a 25-year warranty [1@1]",
        "→ answers the worry",
      ],
    },
    {
      language: "Chinese",
      reply: "★ 是的，都在保修范围内 [^1]\n＞ 逆变器保修 10 年 [^2]\n→ 回应顾虑",
      quotes: { 1: "组件提供 25 年质保。", 2: "逆变器保修 10 年。" },
      text: "★ 是的，都在保修范围内\n逆变器保修 10 年 [^2]\n组件提供 25 年质保 [^1]\n→ 回应顾虑",
      option: [
        "是的，都在保修范围内",
        "  fact: 逆变器保修 10 年 [2@0]",
        "  fact: 组件提供 25 年质保 [1@1]",
        "→ 回应顾虑",
      ],
    },
  ])(
    "in $language, after the option's own fact and above its → line",
    ({ reply, quotes, text, option }) => {
      const { reading, again } = turnedTwice("answer", reply, quotes);
      expect(reading.text).toBe(text);
      expect(optionOf(again.options[0])).toEqual(option);
      expect(reading.kinds).toEqual(["say", "fact", "fact", "effect"]);
    },
  );

  // protects=a turned line is shown beside the option's own two facts, so such an option shows three, the model's two first in their order; fails_when=a fact the model chose is hidden for the turned line, or the turned line is; no_claim=how often an option has three.
  test("an option with two facts of its own shows the turned line as a third", () => {
    const reply =
      "★ Yes, it's covered [^1]\n> Inverters are covered for 10 years [^2]\n> Workmanship is guaranteed for 5 years [^3]\n→ answers the worry";
    const quotes = {
      1: "Panels carry a 25-year warranty.",
      2: "Inverters are covered for 10 years.",
      3: "Workmanship is guaranteed for 5 years.",
    };
    const { again } = turnedTwice("answer", reply, quotes);
    const [option] = again.options;
    expect(option?.notes.map(textOf)).toEqual([
      "Inverters are covered for 10 years [2@0]",
      "Workmanship is guaranteed for 5 years [3@1]",
      "Panels carry a 25-year warranty [1@2]",
    ]);
  });

  // protects=no turned line where a fact line of the option already holds that Citation (the development trial's lost-marker reply, its [^1] kept on its fact line) or a Citation of the same words, nor where it states those words with a marker that backs nothing, which then takes the Citation where it is written; fails_when=an option shows the same fact twice, or a fact loses its Citation; no_claim=how often a model repeats a marker.
  test.each<{ name: string; reply: string; quotes: Record<number, string>; facts: string[] }>([
    {
      name: "the same marker on a fact line (the trial's lost-marker reply)",
      reply:
        "★ The full cost can be deducted from taxable profits in the first year, so we can point to that as the relief[^3]\n> The full cost can be deducted from taxable profits in the first year [^1]\n> We send the paperwork your accountant needs [^2]\n→ answers their question directly",
      quotes: {
        1: "The full cost can be deducted from taxable profits in the first year.",
        2: "We send the paperwork your accountant needs.",
        3: "The full cost can be deducted from taxable profits in the first year.",
      },
      facts: [
        "The full cost can be deducted from taxable profits in the first year [1@1]",
        "We send the paperwork your accountant needs [2@2]",
      ],
    },
    {
      name: "the trial's lost-marker reply, its line to say's marker backing nothing",
      reply:
        "★ The full cost can be deducted from taxable profits in the first year, so we can point to that as the relief[^3]\n> The full cost can be deducted from taxable profits in the first year [^1]\n> We send the paperwork your accountant needs [^2]\n→ answers their question directly",
      quotes: {
        1: "The full cost can be deducted from taxable profits in the first year.",
        2: "We send the paperwork your accountant needs.",
      },
      facts: [
        "The full cost can be deducted from taxable profits in the first year [1@1]",
        "We send the paperwork your accountant needs [2@2]",
      ],
    },
    {
      name: "a fact line of the same words whose marker backs nothing takes the Citation",
      reply:
        "★ Yes, it's covered [^1]\n> Panels carry a 25-year warranty [^7]\n→ answers the worry",
      quotes: { 1: "Panels carry a 25-year warranty." },
      facts: ["Panels carry a 25-year warranty [1@1]"],
    },
  ])("$name", ({ reply, quotes, facts }) => {
    const reading = readWith("answer", reply, quotes);
    const [option] = reading.options;
    expect(option?.notes.map(textOf)).toEqual(facts);
  });

  // protects=a Citation of a line of the call on a line to say isn't turned and its marker comes off, as before; a line to say that quotes words the quote check reads keeps its marker and isn't turned; a "→" line's Document Citation is turned above it; fails_when=a call's words show as a fact line, a quoted line loses its marker, or a "→" line's Citation is lost; no_claim=none beyond protects.
  test("a call's Citation, a quoted line, and a → line's Citation", () => {
    const call = readWith("answer", "★ You told them it's €45 [^1]\n→ confirms it", {});
    expect(call.text).toBe("★ You told them it's €45\n→ confirms it");
    expect(call.options[0]?.notes).toEqual([]);
    const quoted = readWith(
      "answer",
      '★ The sheet says "every plan includes the test sandbox" [^1]\n→ settles it',
      { 1: "Every plan includes the test sandbox." },
    );
    expect(quoted.text).toBe(
      '★ The sheet says "every plan includes the test sandbox" [^1]\n→ settles it',
    );
    expect(quoted.options[0]?.notes).toEqual([]);
    const arrow = readWith("answer", "★ Yes, it's covered\n→ answers the worry [^1]", {
      1: "Panels carry a 25-year warranty.",
    });
    expect(arrow.text).toBe(
      "★ Yes, it's covered\nPanels carry a 25-year warranty [^1]\n→ answers the worry",
    );
  });

  // protects=the same Document Citation left on two options' lines to say gives each option its turned line, each at its own place, so each is judged there, in English and Chinese; fails_when=one option loses its line or both share one place; no_claim=what the check finds.
  test.each([
    {
      language: "English",
      reply:
        "★ Yes, it's covered [^1]\n→ answers the worry\n\nThe panels themselves are covered [^1]\n→ reassures",
      quote: "Panels carry a 25-year warranty.",
    },
    {
      language: "Chinese",
      reply: "★ 是的，在保修范围内 [^1]\n→ 回应顾虑\n\n组件本身也在保修内 [^1]\n→ 让对方放心",
      quote: "组件提供 25 年质保。",
    },
  ])("in $language, the same Citation on two options", ({ reply, quote }) => {
    const { again } = turnedTwice("answer", reply, { 1: quote });
    const places = again.options.flatMap((item) =>
      item.notes.flat().flatMap((piece) => (piece.kind === "citation" ? [piece.at] : [])),
    );
    expect(places).toEqual([0, 1]);
    expect(citedSentences(again.text).flatMap((each) => each.markers)).toEqual([1, 1]);
  });

  // protects=while the reply is written, a turned line shows once its marker is whole and its Citation recorded and the option's facts are written, so it shows in its place after them as the "→" line begins; from then on neither it nor any line above it moves, and only the "→" line goes below it; with no record nothing turns, in English and Chinese; fails_when=a turned line shows before the option's last fact and is pushed down by it, a line above it moves, or a line shows and then goes; no_claim=how soon a model records.
  test.each([
    {
      language: "English",
      reply:
        "★ Yes, it's covered [^1]\n> Inverters are covered for 10 years [^2]\n→ answers the worry",
      quotes: { 1: "Panels carry a 25-year warranty.", 2: "Inverters are covered for 10 years." },
      words: "Panels carry a 25-year warranty",
    },
    {
      language: "Chinese",
      reply: "★ 是的，都在保修范围内 [^1]\n＞ 逆变器保修 10 年 [^2]\n→ 回应顾虑",
      quotes: { 1: "组件提供 25 年质保。", 2: "逆变器保修 10 年。" },
      words: "组件提供 25 年质保",
    },
  ])("in $language, while it is written", ({ reply, quotes, words }) => {
    const panel = (end: number, recorded: Record<number, string>) =>
      optionOf(readWith("answer", reply.slice(0, end), recorded, "streaming").options[0]).map(
        (line) => line.replace(/@\d+\]/g, "]"),
      );
    const final = panel(reply.length, quotes);
    const at = final.findIndex((line) => line.includes(words));
    expect(at).toBe(final.length - 2);
    const arrowBegun = reply.indexOf("→") + 1;
    for (let end = 1; end <= reply.length; end++) {
      const shown = panel(end, quotes);
      expect(panel(end, {}).some((line) => line.includes(words))).toBe(false);
      if (end < arrowBegun) {
        expect(shown.some((line) => line.includes(words))).toBe(false);
        continue;
      }
      expect(shown.findIndex((line) => line.includes(words))).toBe(at);
      expect(shown.slice(0, at + 1)).toEqual(final.slice(0, at + 1));
    }
  });
});
