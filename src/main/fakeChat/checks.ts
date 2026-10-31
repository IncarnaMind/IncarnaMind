/**
 * Check against Documents (`checkReply`): a sentence that shares
 * three words with a Passage's line is supported, or contradicted when it has a
 * number the line doesn't; otherwise unsupported. A sentence the User cites a
 * quote for that `PARTLY` lists, or one with no Citation that `PARTLY_UNCITED`
 * lists, is unsupported and says what the quote covers and what it doesn't.
 * Offered calculate, a sentence that states a multiple ("1.1x") has it worked
 * out as the line's first number over its second (#707).
 * A sentence whose figures are asked for one by one (#1932) gets each bound to
 * the number nearest it in value on the Passage line that shares the most
 * words with its sentence (two at least), or with its row's label and headings
 * in a table (one at least), or found nowhere. A number with no unit of its own
 * on a Passage that states one ("All figures in £m") quotes that line as its unit.
 */

import { WHOLE_READ } from "../../core/answers/checks/absence";
import { SEARCH_AGAIN } from "../../core/answers/checks/searchAgain";
import { readFigures } from "../../shared/figures";
import { KEPT_TO_THE_QUOTE } from "./answers";
import { passagesIn, recordFor, UNIT_MARK } from "./passages";
import {
  type GenerateOptions,
  lastUserText,
  type Prompt,
  type Reply,
  systemOf,
  toolResults,
  userText,
} from "./prompt";

/** A check Run's instructions (#96, src/core/answers/checks/prompt.ts). */
export const CHECK_RUN = /^You check one sentence the User wrote against the User's Documents/m;

/** Words that decide a check: those of four letters or more, and every number. */
const checkWords = (text: string): string[] => [
  ...(text.toLowerCase().match(/[a-z]{4,}|\d+(?:[.,]\d+)?/g) ?? []),
];

/**
 * Sentences the User cites a quote for that the scripted model finds partly
 * supported: what the quote covers, what it doesn't, and the sentence with
 * that part cut, as Cut the unsupported part writes it (./edit, #1111).
 */
export const PARTLY = [
  {
    when: /scaling constraint/,
    covered: "the harbour times",
    uncovered: "the scaling constraint",
    cut: "Harbours publish the times of high water every 12 months.",
  },
  {
    when: /memory needs/,
    covered: "the speed comparison",
    uncovered: "memory and robustness",
    cut: "Experiments usually show quasi-Newton methods are faster than gradient descent, and first-order methods are slower.",
  },
  {
    when: /内存需求/,
    covered: "速度比较",
    uncovered: "内存和鲁棒性",
    cut: "已有实验通常显示，拟牛顿方法比梯度下降更快，一阶优化方法速度较慢。",
  },
];

/**
 * Sentences with no Citation that the scripted model finds partly supported:
 * it records the line it read for them, then says what that line covers and
 * what it doesn't.
 */
export const PARTLY_UNCITED = [
  {
    when: /^Staff /,
    covered: "home working two days a week",
    uncovered: "staff in general",
  },
];

export const ABSENCE_WORDS = /(?:has no|never|没有|从未)/i;

export function fakeAbsence(options: GenerateOptions): string | null {
  const prompt = lastUserText(options.prompt);
  if (!systemOf(options.prompt).startsWith(WHOLE_READ) || !ABSENCE_WORDS.test(prompt)) {
    return null;
  }
  const sentence = /<sentence>\n([\s\S]*?)\n<\/sentence>/.exec(prompt)?.[1] ?? "";
  const contradicted = prompt.includes("Break clause");
  const said = ABSENCE_WORDS.exec(sentence);
  return JSON.stringify({
    // What follows the absence word is what the sentence says is absent.
    absent: said
      ? sentence
          .slice(said.index + said[0].length)
          .replace(/[.。]$/u, "")
          .trim()
      : "",
    absence: contradicted ? "contained" : "holds",
    ...(contradicted && {
      citations: [
        {
          marker: 1,
          passage: /id="([^"]+)"/.exec(prompt)?.[1],
          quote: "Either party may end this lease with 30 days' notice.",
        },
      ],
    }),
  });
}

/** The first quote the check is given for its sentence. */
const citedQuote = (first: string) => /^- [^\n]*?: “([^\n]+)”$/m.exec(first)?.[1] ?? null;

/** The record of `quote`, on a Passage shown so far that holds it. */
function keptToItsQuote(quote: string, shown: readonly string[]): Record<string, unknown> | null {
  const passage = shown.flatMap(passagesIn).find((each) => each.text.includes(quote));
  return passage ? (recordFor(passage, quote, 1)?.record ?? null) : null;
}

/**
 * A table's row the scripted Answers write gives figures the Passage its Citation quotes holds:
 * each number of the sentence is in that Passage, so the row is supported.
 */
function numbersAllCited(sentence: string, first: string): boolean {
  if (!/^The User cites this for it/m.test(first)) return false;
  const numbers = checkWords(sentence).filter((word) => /\d/.test(word));
  const cited = passagesIn(first)
    .map((each) => each.text)
    .join("\n");
  return numbers.length > 0 && numbers.every((number) => cited.includes(number));
}

const absenceLine = (sentence: string) => `Absence: ${ABSENCE_WORDS.test(sentence) ? "yes" : "no"}`;

const withAbsence = (sentence: string, verdict: string): Reply => ({
  text: `${verdict}\n${absenceLine(sentence)}`,
});

/**
 * A check of one sentence (#96): it searches for the sentence, then takes the
 * Passage line that shares the most words with it. Three shared words or more
 * support it, unless the sentence has a number the line doesn't while the
 * line has numbers: that contradicts it. Fewer leave it unsupported. A
 * sentence with "blank reply" gets an empty reply, one with "refuse" a refusal,
 * and one with "no reason" an unsupported verdict with no reason. Asked to
 * search again before it says a sentence isn't found, it searches the
 * sentence's longer words and numbers alone.
 * Offered calculate, a sentence that states a multiple has it worked out first.
 * The scripted Answers' own sentences (`KEPT_TO_THE_QUOTE`), judged once the Answer ends
 * (#2311), are supported by the quote they cite.
 */
export function checkReply(prompt: Prompt, tools: readonly string[]): Reply {
  // The sentence is in the first message: the check may have been asked to search again since.
  const first = userText(prompt.find((message) => message.role === "user"));
  const sentence = /<sentence>\n([\s\S]*?)\n<\/sentence>/.exec(first)?.[1] ?? "";
  if (/blank reply/i.test(sentence)) return { text: "" };
  if (/\brefuse\b/i.test(sentence)) return { text: "I'm sorry, I can't help with that." };
  const searches = toolResults(prompt, "search_documents");
  const searched = searches.at(-1);
  const asked = /<figures>\n([\s\S]*?)\n<\/figures>/.exec(first)?.[1];
  // A table cell's own words are its number: what it is comes from its row's label.
  const labels = asked
    ? (JSON.parse(asked) as AskedFigure[]).flatMap((figure) => {
        const row = rowOf(figure);
        return row ? [row] : [];
      })
    : [];
  if (searched === undefined)
    return { tool: "search_documents", input: { query: [sentence, ...labels].join(" ") } };
  if (searches.length === 1 && lastUserText(prompt).includes(SEARCH_AGAIN)) {
    return { tool: "search_documents", input: { query: checkWords(sentence).join(" ") } };
  }
  if (asked) return figuresReply(prompt, tools, asked, sentence, searched);
  const quote =
    KEPT_TO_THE_QUOTE.test(sentence) || numbersAllCited(sentence, first) ? citedQuote(first) : null;
  const kept = quote ? keptToItsQuote(quote, [first, ...searches]) : null;
  // A quote kept from a Note's Citation may be on a Passage no search for the sentence found.
  if (quote && !kept && searches.length === 1) {
    return { tool: "search_documents", input: { query: quote } };
  }
  if (kept && toolResults(prompt, "cite").length === 0) {
    return { tool: "cite", input: { citations: [kept] } };
  }
  if (kept) return withAbsence(sentence, "Verdict: supported\nThe Document says so [^1].");
  const words = checkWords(sentence);
  let best: { record: Record<string, unknown>; line: string; shared: number } | null = null;
  for (const passage of passagesIn(searched)) {
    const found = recordFor(passage, sentence, 1);
    const line = typeof found?.record.quote === "string" ? found.record.quote : "";
    const shared = checkWords(line).filter((word) => words.includes(word)).length;
    if (found && (!best || shared > best.shared)) best = { record: found.record, line, shared };
  }
  if (/\bno reason\b/i.test(sentence)) return withAbsence(sentence, "Verdict: unsupported");
  const cited = /^The User cites this for it/m.test(first);
  const partly = cited
    ? PARTLY.find((each) => each.when.test(sentence))
    : PARTLY_UNCITED.find((each) => each.when.test(sentence));
  if (partly && !cited && best && toolResults(prompt, "cite").length === 0) {
    return { tool: "cite", input: { citations: [best.record] } };
  }
  if (partly) {
    return withAbsence(
      sentence,
      `Verdict: unsupported\nCovered: ${partly.covered}\nNot covered: ${partly.uncovered}`,
    );
  }
  if (!best || best.shared < 3) return withAbsence(sentence, "Verdict: unsupported");
  const lineNumbers = checkWords(best.line).filter((word) => /\d/.test(word));
  const contradicted =
    lineNumbers.length > 0 && words.some((word) => /\d/.test(word) && !lineNumbers.includes(word));
  if (toolResults(prompt, "cite").length === 0) {
    return { tool: "cite", input: { citations: [best.record] } };
  }
  const multiple = /\d+(?:\.\d+)?x\b/.exec(sentence)?.[0];
  if (tools.includes("calculate") && multiple && toolResults(prompt, "calculate").length === 0) {
    const inputs = [1, 2].map((position) => ({
      name: `n${position}`,
      label: position === 1 ? "First" : "Second",
      citation: 1,
      position,
    }));
    return {
      tool: "calculate",
      input: {
        figures: [
          {
            marker: 1,
            label: "Multiple",
            inputs,
            formula: "n1 / n2",
            as: "times",
            stated: multiple,
            relation: "equals",
          },
        ],
      },
    };
  }
  // The figure worked out is the only number the sentence has: the rest of it is supported.
  if (multiple && tools.includes("calculate")) {
    return withAbsence(sentence, "Verdict: supported\nThe Document's figures give it [^1].");
  }
  return withAbsence(
    sentence,
    contradicted
      ? `Verdict: contradicted\nThe Document says: ${best.line} [^1]`
      : `Verdict: supported\nThe Document says so [^1].`,
  );
}

interface AskedFigure {
  id: string;
  shown: string;
  context?: string;
  label?: string;
  saved?: unknown;
  ambiguities?: { kind: string }[];
}

// A cell's label is its row, then its column ("Groceries · Q3 2026"): the row names its line.
const rowOf = (figure: AskedFigure) => figure.label?.split(" · ")[0];

/** A line of a Passage that states its figures' scale or currency: "All figures in £m", "单位：百万元". */
const UNIT_LINE = /^(?:all figures in|figures in)\b|^单位[:：]/i;

/** How far apart two numbers are, whatever scale each is written in. */
const apart = (a: number, b: number) =>
  a === 0 || b === 0 ? Math.abs(a - b) : Math.abs(Math.log10(Math.abs(a) / Math.abs(b)) % 3);

/** A multiple the sentence states, as "1.3x": offered calculate, it is worked out from its line. */
const MULTIPLE = /\d+(?:\.\d+)?x\b/;

function figuresReply(
  prompt: Prompt,
  tools: readonly string[],
  asked: string,
  sentence: string,
  searched: string,
): Reply {
  const figures = JSON.parse(asked) as AskedFigure[];
  const passages = passagesIn(searched);
  const lines = new Map<
    string,
    { record: Record<string, unknown>; marker: number; unitLine: string | null }
  >();
  const bound = figures.map((figure) => {
    if (figure.saved) return { figure, line: null };
    const row = rowOf(figure);
    const about = row ? `${row} ${figure.context ?? ""}` : sentence;
    let best: {
      record: Record<string, unknown>;
      quote: string;
      shared: number;
      unitLine: string | null;
    } | null = null;
    for (const passage of passages) {
      // A row named by a short name with a digit ("Q13") is the line that names it, whole.
      const names = about
        .toLowerCase()
        .split(/\W+/)
        .filter((word) => word.length < 4 && /\d/.test(word) && /\p{L}/u.test(word));
      const found = recordFor(passage, about, lines.size + 1, (line) =>
        names.some((name) => line.toLowerCase().split(/\W+/).includes(name)),
      );
      const quote = typeof found?.record.quote === "string" ? found.record.quote : "";
      const words = checkWords(about);
      const shared = checkWords(quote).filter((word) => words.includes(word)).length;
      const unitLine =
        passage.text
          .split("\n")
          .map((line) => line.replace(UNIT_MARK, "").trim())
          .find((line) => UNIT_LINE.test(line)) ?? null;
      if (found && (!best || shared > best.shared))
        best = { record: found.record, quote, shared, unitLine };
    }
    if (!best || best.shared < (figure.label ? 1 : 2)) return { figure, line: null };
    const known = lines.get(best.quote) ?? {
      record: { ...best.record, marker: lines.size + 1 },
      marker: lines.size + 1,
      unitLine: best.unitLine,
    };
    lines.set(best.quote, known);
    return { figure, line: { quote: best.quote, marker: known.marker, unitLine: known.unitLine } };
  });
  if (lines.size > 0 && toolResults(prompt, "cite").length === 0) {
    return { tool: "cite", input: { citations: [...lines.values()].map((line) => line.record) } };
  }
  const worked = tools.includes("calculate")
    ? bound.filter(({ figure, line }) => line && MULTIPLE.test(figure.shown))
    : [];
  if (worked.length > 0 && toolResults(prompt, "calculate").length === 0) {
    return {
      tool: "calculate",
      input: {
        figures: worked.map(({ figure, line }, index) => ({
          marker: index + 1,
          label: "Multiple",
          inputs: [1, 2].map((position) => ({
            name: `n${position}`,
            label: position === 1 ? "First" : "Second",
            citation: line?.marker,
            position,
          })),
          formula: "n1 / n2",
          as: "times",
          stated: figure.shown,
          relation: "equals",
        })),
      },
    };
  }
  const judged = { scope: "same", roles: "same", says: null, reading: null, relation: "equals" };
  const items = bound.map(({ figure, line }) => {
    const marker = worked.findIndex((each) => each.figure === figure) + 1;
    if (figure.saved || marker > 0)
      return {
        id: figure.id,
        verdict: "supported",
        topic: "found",
        ...judged,
        source: null,
        calculation: marker > 0 ? marker : null,
      };
    const value = readFigures(figure.shown)[0]?.value;
    const numbers = line ? readFigures(line.quote, { midLine: true }) : [];
    const nearest =
      value === undefined
        ? -1
        : numbers.reduce(
            (best, each, index) =>
              best < 0 || apart(each.value, value) < apart(numbers[best]?.value ?? 0, value)
                ? index
                : best,
            -1,
          );
    if (!line || nearest < 0)
      return {
        id: figure.id,
        verdict: "unsupported",
        topic: "not found",
        ...judged,
        source: null,
        calculation: null,
      };
    const bare = numbers[nearest]?.unit.kind === "plain" && numbers[nearest]?.scale === 1;
    const unitQuote = bare ? line.unitLine : null;
    const own = figure.ambiguities?.length === 1 ? figure.ambiguities[0] : undefined;
    return {
      id: figure.id,
      verdict: "supported",
      topic: "found",
      ...judged,
      reading: own ? (own.kind === "scale" && unitQuote ? 2 : 1) : null,
      // A lone number's separators settle nothing in its Document: it reads as written.
      source: { citation: line.marker, position: nearest + 1, reading: 1, unitQuote },
      calculation: null,
    };
  });
  return {
    text: `Verdict: supported\n${absenceLine(sentence)}\nFigures: ${JSON.stringify({ items, remainder: null })}`,
  };
}
