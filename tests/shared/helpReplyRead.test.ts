import { describe, expect, test } from "vitest";
import { withoutFootnoteDefinitions } from "../../src/core/answers/citations";
import { quotedWordsIn } from "../../src/core/answers/quotedWords";
import type { AnswerStatus } from "../../src/core/api";
import { helpParts, quoted } from "../../src/renderer/src/helpReply";
import { MARKER } from "../../src/shared/answerSentences";
import { helpLayout, helpReplyRead, type ReplyPiece } from "../../src/shared/helpReplyRead";
import type { MeetingHelpKind } from "../../src/shared/meetingHelp";

const A = "Panels sit on frames held down by ballast weights.";
const B = "We can remove them without a trace.";

const textOf = (pieces: readonly ReplyPiece[]) =>
  pieces
    .map((piece) => (piece.kind === "text" ? piece.text : `[${piece.marker}]`))
    .join("")
    .trim();

/**
 * A reply read as the core keeps it once it ends, and both sides of it: the panel's lines, an
 * option to say in its own quotation marks, and the words the check looks for on the cited pages.
 */
function bothSides(kind: MeetingHelpKind, reply: string, status: AnswerStatus = "done") {
  const kept = helpReplyRead(reply, helpLayout(kind, { status, textBehind: false })).text;
  const panelOf = (text: string) => {
    const { lead, options } = helpParts({ text, status }, kind);
    return [...lead, ...options].flatMap((item) => [
      `${item.recommended ? "★ " : ""}${textOf(item.said ? quoted(item.lead) : item.lead)}`,
      ...item.notes.map((note) => `  ${textOf(note)}`),
      ...(item.effect ? [`→ ${textOf(item.effect)}`] : []),
    ]);
  };
  const looks = quotedWordsIn(withoutFootnoteDefinitions(kept)).map((each) => each.words);
  return { kept, panel: panelOf(kept), asWritten: panelOf(reply), looks };
}

describe("A call-help reply reads alike in its panel and its check (#2925)", () => {
  // protects=for each form a model writes an option, a reading or a short line in, the panel shows the words without the model's quotation marks and the check doesn't look for them, or it shows them as written and the check looks: never one without the other; the reply is kept as read, its markers as written but for a reading's first line's (#2847), and the panel reads it the same either way; fails_when=an option shows bare while the check looks for its words on the cited page, a reading's moment or a short line loses its quotation marks, or a marker is lost; no_claim=whether the words are on the page.
  test.each<{
    form: string;
    kind: MeetingHelpKind;
    reply: string;
    panel: string[];
    looks: string[];
    /** The reply as kept, where it isn't the reply as written less an option's own pair. */
    kept?: string;
  }>([
    {
      form: "1 the plain wrapped form",
      kind: "say",
      reply: `★ "${A}"[^1]\n→ It answers the roof worry.\n\n"${B}"[^2]\n→ It moves to the lease.`,
      panel: [
        `★ “${A}”[1]`,
        "→ It answers the roof worry.",
        `“${B}”[2]`,
        "→ It moves to the lease.",
      ],
      looks: [],
    },
    {
      form: "2 the effect written ->",
      kind: "say",
      reply: `★ "${A}"[^1]\n-> It answers the roof worry.\n\n"${B}"[^2]\n-> It moves to the lease.`,
      panel: [
        `★ “${A}”[1]`,
        "→ It answers the roof worry.",
        `“${B}”[2]`,
        "→ It moves to the lease.",
      ],
      looks: [],
    },
    {
      form: "3 the other star",
      kind: "say",
      reply: `⭐ "${A}"[^1]\n→ It answers the roof worry.`,
      panel: [`★ “${A}”[1]`, "→ It answers the roof worry."],
      looks: [],
    },
    {
      form: "4 a lead-in line directly above",
      kind: "say",
      reply: `Here are two things you could say:\n★ "${A}"[^1]\n→ It answers the roof worry.\n\n"${B}"[^2]\n→ It moves to the lease.`,
      panel: [
        `★ “${A}”[1]`,
        "→ It answers the roof worry.",
        `“${B}”[2]`,
        "→ It moves to the lease.",
      ],
      looks: [],
    },
    {
      form: "5 a heading directly above",
      kind: "say",
      reply: `## Options\n★ "${A}"[^1]\n→ It answers the roof worry.`,
      panel: [`★ “${A}”[1]`, "→ It answers the roof worry."],
      looks: [],
    },
    {
      form: "6 numbered options",
      kind: "say",
      reply: `1. "${A}"[^1]\n→ It answers the roof worry.\n2. "${B}"[^2]\n→ It moves to the lease.`,
      panel: [`“${A}”[1]`, "→ It answers the roof worry.", `“${B}”[2]`, "→ It moves to the lease."],
      looks: [],
    },
    {
      form: "7 bulleted options",
      kind: "say",
      reply: `- "${A}"[^1]\n→ It answers the roof worry.\n- "${B}"[^2]\n→ It moves to the lease.`,
      panel: [`“${A}”[1]`, "→ It answers the roof worry.", `“${B}”[2]`, "→ It moves to the lease."],
      looks: [],
    },
    {
      form: "8 the whole line in bold, closed before the marker",
      kind: "say",
      reply: `**★ "${A}"**[^1]\n→ It answers the roof worry.`,
      panel: [`★ “${A}”[1]`, "→ It answers the roof worry."],
      looks: [],
    },
    // With no "→" line it is no option to say, as a remark after the options isn't: the panel shows
    // it as written, in the model's marks, and the check looks for its words.
    {
      form: "9 the last option's → never came",
      kind: "say",
      reply: `★ "${A}"[^1]\n→ It answers the roof worry.\n\n"${B}"[^2]`,
      panel: [`★ “${A}”[1]`, "→ It answers the roof worry.", `"${B}"[2]`],
      looks: ["We can remove them without a trace"],
    },
    {
      form: "10 an option straight after a → line",
      kind: "say",
      reply: `★ "${A}"[^1]\n→ It answers the roof worry.\n"${B}"[^2]\n→ It moves to the lease.`,
      panel: [
        `★ “${A}”[1]`,
        "→ It answers the roof worry.",
        `“${B}”[2]`,
        "→ It moves to the lease.",
      ],
      looks: [],
    },
    {
      form: "11 a mixed pair",
      kind: "say",
      reply: `★ “${A}"[^1]\n→ It answers the roof worry.`,
      panel: [`★ “${A}”[1]`, "→ It answers the roof worry."],
      looks: [],
    },
    // Quotations of the Document inside an option keep their marks; these are shorter than the four
    // words any Answer's check takes for a quotation (#483).
    {
      form: "12 two quotations of the Document, no marks of the model's own",
      kind: "say",
      reply: `★ "ballast weights" hold the frames, and "nothing is drilled"[^1]\n→ It answers the roof worry.`,
      panel: [
        `★ “"ballast weights" hold the frames, and "nothing is drilled"”[1]`,
        "→ It answers the roof worry.",
      ],
      looks: [],
    },
    {
      form: "12, the quotations long enough to be looked for",
      kind: "say",
      reply: `★ "ballast weights hold the frames" and "nothing is drilled through the roof"[^1]\n→ It answers the roof worry.`,
      panel: [
        `★ “"ballast weights hold the frames" and "nothing is drilled through the roof"”[1]`,
        "→ It answers the roof worry.",
      ],
      looks: ["ballast weights hold the frames", "nothing is drilled through the roof"],
    },
    {
      form: "13 a full stop after the closing mark",
      kind: "say",
      reply: `★ "Panels sit on frames held down by ballast weights".[^1]\n→ It answers the roof worry.`,
      panel: [`★ “${A}”[1]`, "→ It answers the roof worry."],
      looks: [],
    },
    {
      form: "14 the star after a dash",
      kind: "say",
      reply: `- ★ "${A}"[^1]\n→ It answers the roof worry.`,
      panel: [`★ “${A}”[1]`, "→ It answers the roof worry."],
      looks: [],
    },
    {
      form: "15 the → line indented in bold",
      kind: "say",
      reply: `★ "${A}"[^1]\n  **→** It answers the roof worry.`,
      panel: [`★ “${A}”[1]`, "→ It answers the roof worry."],
      looks: [],
    },
    {
      form: "16 a blank line between the option and its →",
      kind: "say",
      reply: `★ "${A}"[^1]\n\n→ It answers the roof worry.`,
      panel: [`★ “${A}”[1]`, "→ It answers the roof worry."],
      looks: [],
    },
    {
      form: "17 Chinese corner marks, the effect written ->",
      kind: "say",
      reply: "★ 「面板放在配重压住的支架上。」[^1]\n-> 回应对屋顶的担心。",
      panel: ["★ “面板放在配重压住的支架上。”[1]", "→ 回应对屋顶的担心。"],
      looks: [],
    },
    {
      form: "18 a reading and its moment, as asked",
      kind: "want",
      reply: `★ They want a lower price.[^1]\n"We can't go above forty."[^2]\n→ Offer the two-year term.`,
      panel: [
        "★ They want a lower price.",
        `  "We can't go above forty."[2]`,
        "→ Offer the two-year term.",
      ],
      looks: ["We can't go above forty"],
      kept: `★ They want a lower price.\n"We can't go above forty."[^2]\n→ Offer the two-year term.`,
    },
    {
      form: "19 a reading, its moment after a blank line",
      kind: "want",
      reply: `★ They want a lower price.[^1]\n\n"We can't go above forty."[^2]\n→ Offer the two-year term.`,
      panel: [
        "★ They want a lower price.",
        `  "We can't go above forty."[2]`,
        "→ Offer the two-year term.",
      ],
      looks: ["We can't go above forty"],
      kept: `★ They want a lower price.\n\n"We can't go above forty."[^2]\n→ Offer the two-year term.`,
    },
    {
      form: "20 a reading that is only its moment",
      kind: "want",
      reply: `★ "We can't go above forty."[^2]\n→ They want a lower price; offer the two-year term.`,
      panel: [
        `★ "We can't go above forty."[2]`,
        "→ They want a lower price; offer the two-year term.",
      ],
      looks: ["We can't go above forty"],
    },
    {
      form: "21 a second reading whose first line is its moment",
      kind: "want",
      reply: `★ They want a lower price.[^1]\n"We can't go above forty."[^2]\n→ Offer the two-year term.\n\n"Send me the numbers by Friday."[^3]\n→ They want it in writing.`,
      panel: [
        "★ They want a lower price.",
        `  "We can't go above forty."[2]`,
        "→ Offer the two-year term.",
        `"Send me the numbers by Friday."[3]`,
        "→ They want it in writing.",
      ],
      looks: ["We can't go above forty", "Send me the numbers by Friday"],
      kept: `★ They want a lower price.\n"We can't go above forty."[^2]\n→ Offer the two-year term.\n\n"Send me the numbers by Friday."[^3]\n→ They want it in writing.`,
    },
    {
      form: "22 short lines, one a quotation",
      kind: "sum",
      reply: `- The roof isn't drilled.[^1]\n- "nothing is drilled through the roof"[^1]\n- The lease is next.`,
      panel: [
        "The roof isn't drilled.[1]",
        `"nothing is drilled through the roof"[1]`,
        "The lease is next.",
      ],
      looks: ["nothing is drilled through the roof"],
    },
    // The call's words in single marks stay as written: no Answer's check takes those for a
    // quotation, as they would pair an apostrophe (#483).
    {
      form: "23 an option that quotes the call, then its →",
      kind: "answer",
      reply: `★ "You said 'we can't go above forty', so here is the two-year term."[^2]\n→ It ties the offer to their limit.`,
      panel: [
        "★ “You said 'we can't go above forty', so here is the two-year term.”[2]",
        "→ It ties the offer to their limit.",
      ],
      looks: [],
    },
    {
      form: "24 an option that is one whole quotation of the Document, as its answer",
      kind: "answer",
      reply: `★ "The warranty covers the panels for 25 years."[^1]\n→ It answers their question in the contract's words.`,
      panel: [
        "★ “The warranty covers the panels for 25 years.”[1]",
        "→ It answers their question in the contract's words.",
      ],
      looks: [],
    },
  ])("$form", ({ kind, reply, panel, looks, kept }) => {
    const sides = bothSides(kind, reply);
    expect(sides.panel).toEqual(panel);
    expect(sides.looks).toEqual(looks);
    expect(sides.asWritten).toEqual(panel);
    expect(sides.kept.match(MARKER)).toEqual((kept ?? reply).match(MARKER));
    expect(
      helpReplyRead(sides.kept, helpLayout(kind, { status: "done", textBehind: false })).text,
    ).toBe(sides.kept);
    if (kind === "want" || kind === "sum") expect(sides.kept).toBe(kept ?? reply);
  });

  // protects=an option wrapped whole is kept without the pair, its marker inside the marks or after them, after bold or a star, in straight, curly and corner marks; fails_when=a mark is left or a word, a star, bold or a marker changes; no_claim=how the panel draws it.
  test.each([
    ['★ "We can extend the pilot [^1]"', "★ We can extend the pilot [^1]"],
    ['★ "We can extend the pilot" [^1]', "★ We can extend the pilot [^1]"],
    ["★ “We can extend the pilot [^1].”", "★ We can extend the pilot [^1]."],
    ["「我们可以延长试用期」[^1]", "我们可以延长试用期[^1]"],
    ['**★ "We can extend the pilot" [^1]**', "**★ We can extend the pilot [^1]**"],
    ['★ **"We can extend the pilot" [^1]**', "★ **We can extend the pilot [^1]**"],
  ])("an option wrapped in the model's own marks is kept without them: %s", (option, kept) => {
    expect(bothSides("say", `${option}\n→ keeps it moving`).kept).toBe(
      `${kept}\n→ keeps it moving`,
    );
  });

  // protects=only the model's pair around a whole option comes off: a quotation inside it in another kind of mark, an empty pair and a pair inside the pair stay as written; fails_when=a quotation inside an option loses a mark, or a second reading takes off more than the first; no_claim=which words the check finds.
  test.each([
    [
      '★ "We confirm “nothing is ever drilled” on site" [^1]',
      "★ We confirm “nothing is ever drilled” on site [^1]",
    ],
    ["★ “屋顶上「绝不打孔」，请放心” [^1]", "★ 屋顶上「绝不打孔」，请放心 [^1]"],
    ['★ "" [^1]', '★ "" [^1]'],
    ['★ "“We can extend the pilot”" [^1]', '★ "“We can extend the pilot”" [^1]'],
  ])("only the option's own pair comes off: %s", (option, kept) => {
    const reply = `${option}\n→ answers the worry`;
    const sides = bothSides("say", reply);
    expect(sides.kept).toBe(`${kept}\n→ answers the worry`);
    expect(bothSides("say", sides.kept).kept).toBe(sides.kept);
  });

  // protects=an option to say is one whether or not the panel has room for it: a third wrapped option is kept without the model's pair, as the two shown are, and isn't looked for, while the panel still shows two; fails_when=the third keeps its marks, so the assistant shows it beside two bare ones and the check looks for its words; no_claim=how often a model writes a third option.
  test("a third option the panel has no room for is kept and checked as the two it shows", () => {
    const C = "We can send the warranty terms in writing today.";
    const reply = `★ "${A}"[^1]\n→ It answers the roof worry.\n\n"${B}"[^2]\n→ It moves to the lease.\n\n"${C}"[^3]\n→ It buys time.`;
    const sides = bothSides("say", reply);
    expect(sides.kept).toBe(
      `★ ${A}[^1]\n→ It answers the roof worry.\n\n${B}[^2]\n→ It moves to the lease.\n\n${C}[^3]\n→ It buys time.`,
    );
    expect(sides.looks).toEqual([]);
    expect(sides.panel).toEqual([
      `★ “${A}”[1]`,
      "→ It answers the roof worry.",
      `“${B}”[2]`,
      "→ It moves to the lease.",
    ]);
  });

  // protects=a Citation marker on a "→" line comes off, whichever arrow, bold or language the model wrote it in, and before a full stop or a word, while every other marker stays and the chips count places as the reply was written; fails_when=a "→" line keeps its chip or goes to the check, another line loses a marker, a space is left before a full stop, or a chip's place moves; no_claim=what the check finds.
  test.each([
    [
      "★ We can do 60 days [^1]\n→ keeps it moving [^2]",
      "★ We can do 60 days [^1]\n→ keeps it moving",
    ],
    [
      "★ We can do 60 days [^1]\n-> keeps it moving [^2]",
      "★ We can do 60 days [^1]\n-> keeps it moving",
    ],
    [
      "★ We can do 60 days [^1]\n**→ keeps it moving [^2]**",
      "★ We can do 60 days [^1]\n**→ keeps it moving**",
    ],
    [
      "★ We can do 60 days [^1]\n→ keeps it moving [^2].",
      "★ We can do 60 days [^1]\n→ keeps it moving.",
    ],
    [
      "★ We can do 60 days [^1]\n→ keeps [^2] it moving",
      "★ We can do 60 days [^1]\n→ keeps it moving",
    ],
    ["★ 我们可以延长到 60 天 [^1]\n→ 推进成交 [^2]", "★ 我们可以延长到 60 天 [^1]\n→ 推进成交"],
  ])("a → line's marker comes off: %s", (reply, kept) => {
    const read = helpReplyRead(reply, helpLayout("say", { status: "done", textBehind: false }));
    expect(read.text).toBe(kept);
    const [option] = read.options;
    expect(option?.effect?.some((piece) => piece.kind === "citation")).toBe(false);
    expect(option?.lead.flatMap((piece) => (piece.kind === "citation" ? [piece.at] : []))).toEqual([
      0,
    ]);
  });

  // protects=a reply kept before the "→" rule, a marker still on its "→" line, shows each other chip at the place its check gave it, so no ✓ moves to another chip; fails_when=the second option's chip counts its place without the "→" line's marker; no_claim=how such a reply was written.
  test("a reply kept with a marker on its → line shows every other chip at its place as written", () => {
    const reply = `★ ${A}[^1]\n→ It answers the roof worry [^2]\n\n${B}[^3]\n→ It moves to the lease.`;
    const read = helpReplyRead(reply, helpLayout("say", { status: "done", textBehind: false }));
    expect(read.text).toBe(
      `★ ${A}[^1]\n→ It answers the roof worry\n\n${B}[^3]\n→ It moves to the lease.`,
    );
    const places = read.options.flatMap((item) =>
      [item.lead, item.effect ?? []]
        .flat()
        .flatMap((piece) => (piece.kind === "citation" ? [[piece.marker, piece.at]] : [])),
    );
    expect(places).toEqual([
      [1, 0],
      [3, 2],
    ]);
    // Kept, the reply reads again as kept: its places are those of the text its check reads.
    const again = helpReplyRead(
      read.text,
      helpLayout("say", { status: "done", textBehind: false }),
    );
    expect(again.text).toBe(read.text);
    expect(
      again.options.flatMap((item) =>
        item.lead.flatMap((piece) => (piece.kind === "citation" ? [piece.at] : [])),
      ),
    ).toEqual([0, 1]);
  });

  // protects=a reading's first line, the reply's own reading, loses its marker in English and Chinese, while its moment keeps its own and its quotation marks; a reading written only as its moment keeps its marker; nothing comes off a short line; fails_when=a reading's first line keeps a chip, its moment loses one, a reading that is only its moment loses its Citation of the call, or a short line changes; no_claim=how the model words a reading.
  test.each([
    [
      "★ They want the total [^1]\n12:04 “our budget stops at ten” [^2]\n→ give the tier [^3]",
      "★ They want the total\n12:04 “our budget stops at ten” [^2]\n→ give the tier",
    ],
    [
      "★ 对方想要总价 [^1]\n12:04 “我们的预算上限是一万” [^2]\n→ 先给阶梯价",
      "★ 对方想要总价\n12:04 “我们的预算上限是一万” [^2]\n→ 先给阶梯价",
    ],
    [
      "★ They want a lower price [^1]\n→ offer the two-year term",
      "★ They want a lower price\n→ offer the two-year term",
    ],
    [
      "★ “We can't go above forty” [^1]\n→ they want a lower price",
      "★ “We can't go above forty” [^1]\n→ they want a lower price",
    ],
  ])("a reading's first line loses its marker, its moment keeps its own: %s", (reply, kept) => {
    const layout = helpLayout("want", { status: "done", textBehind: false });
    const read = helpReplyRead(reply, layout);
    expect(read.text).toBe(kept);
    expect(helpReplyRead(read.text, layout).text).toBe(read.text);
  });

  test("nothing comes off a short line", () => {
    const reply = "- The roof isn't drilled [^1]\n- 上线推迟到 11 月 18 日 [^2]";
    expect(
      helpReplyRead(reply, helpLayout("sum", { status: "done", textBehind: false })).text,
    ).toBe(reply);
  });

  // protects=while a reply streams the panel never draws a "→" line's marker, so no chip shows that its end would take away; fails_when=a chip shows on a "→" line before the reply ends; no_claim=how long the reply takes.
  test("while it streams, a → line's marker is never drawn", () => {
    const reply = "★ We can do 60 days [^1]\n→ keeps it moving [^2]";
    for (let end = 1; end <= reply.length; end++) {
      const { options } = helpReplyRead(
        reply.slice(0, end),
        helpLayout("say", { status: "streaming", textBehind: false }),
      );
      const markers = options.flatMap((item) =>
        (item.effect ?? []).flatMap((piece) => (piece.kind === "citation" ? [piece.marker] : [])),
      );
      expect(markers).toEqual([]);
    }
  });

  // protects=while a reply is written, and once it was stopped, the panel shows an option as it is kept, so its words don't change at its end; fails_when=the panel shows the model's marks until the reply ends, or an option before the star (a model's notes) loses its marks; no_claim=how long the reply takes.
  test.each<AnswerStatus>(["streaming", "stopped"])("read as kept while %s", (status) => {
    const reply = `I'll look at the sheet first.\n→ notes\n\n★ "${A}"[^1]\n→ It answers the roof worry.`;
    const sides = bothSides("say", reply, status);
    expect(sides.panel).toEqual([`★ “${A}”[1]`, "→ It answers the roof worry."]);
    expect(sides.kept).toBe(
      `I'll look at the sheet first.\n→ notes\n\n★ ${A}[^1]\n→ It answers the roof worry.`,
    );
  });
});
