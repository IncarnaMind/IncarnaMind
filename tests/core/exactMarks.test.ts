/**
 * The one ask about an Answer's nested quotation marks (#2504, src/core/answers/exactMarks.ts):
 * quoted words that differ from the page only in their marks' kind are asked about once, and a
 * reply is taken only when the check finds it exactly, with the same words, at the same place.
 * Matching itself never changes.
 */
import { describe, expect, test } from "vitest";
import {
  type CitedPages,
  EXACT_MARKS_INSTRUCTIONS,
  exactMarks,
} from "../../src/core/answers/exactMarks";
import { asksForExactMarks } from "../../src/core/providers/catalog/answerPaths";
import {
  answerEnded,
  askNew,
  onlyCitation,
  type ShownPassage,
  type SourceFile,
  setUpWithDocuments,
  shownPassages,
} from "../helpers/citations";
import { answerText } from "../helpers/minds";
import { type ModelCall, type ScriptedReply, scriptedModel } from "../helpers/models";

interface Case {
  file: SourceFile;
  query: string;
  question: string;
  /** The record's quote, which is on the page. */
  quote: string;
}

const RETURNS: Case = {
  file: {
    name: "Returns policy.md",
    contents:
      "# Returns policy\n\nThe “cooling-off period” lasts 14 days from delivery for every order.\n",
  },
  query: "cooling-off period",
  question: "How long is the cooling-off period?",
  quote: "The “cooling-off period” lasts 14 days from delivery",
};
const NESTED_EN =
  "It says “the ‘cooling-off period’ lasts 14 days from delivery for every order”[^1].";
const PAGE_EN = "the “cooling-off period” lasts 14 days from delivery for every order";

const ATTENTION: Case = {
  file: {
    name: "注意力机制.md",
    contents:
      "# 注意力机制\n\n注意力机制的灵活性来自于它的“软权重”特性，即这种权重是可以在运行时改变的。\n",
  },
  query: "软权重",
  question: "注意力机制为什么更灵活？",
  quote: "注意力机制的灵活性来自于它的“软权重”特性",
};
const NESTED_ZH =
  "文中写道“注意力机制的灵活性来自于它的‘软权重’特性，即这种权重是可以在运行时改变的”[^1]。";
const PAGE_ZH = "注意力机制的灵活性来自于它的“软权重”特性，即这种权重是可以在运行时改变的";

/** The reply the ask gets: each quotation's id with a quote, null, or what the test gives. */
type Reply = ScriptedReply | ((call: ModelCall) => ScriptedReply);

/** A model that cites `quote` and writes `answer`, and replies `reply` to the ask about its marks. */
function model({ query, quote }: Case, answer: string, reply?: Reply) {
  const asked: ModelCall[] = [];
  const scripted = scriptedModel((call) => {
    if (call.system === EXACT_MARKS_INSTRUCTIONS) {
      asked.push(call);
      if (!reply) throw new Error("The Answer asked about its marks.");
      return typeof reply === "function" ? reply(call) : reply;
    }
    const searches = call.results.filter((result) => result.tool === "search_documents");
    if (searches.length === 0) {
      return { calls: [{ tool: "search_documents", input: { query } }] };
    }
    if (!call.results.some((result) => result.tool === "cite")) {
      const passages: ShownPassage[] = shownPassages(searches.at(-1)?.text ?? "");
      return {
        calls: [
          { tool: "cite", input: { citations: [{ marker: 1, passage: passages[0]?.id, quote }] } },
        ],
      };
    }
    return { text: answer };
  });
  return { scripted, asked };
}

const quotes = (...each: (string | null)[]): ScriptedReply => ({
  text: JSON.stringify({ quotes: each.map((quote, index) => ({ id: index + 1, quote })) }),
});

async function answer(
  each: Case,
  sentence: string,
  reply?: Reply,
  { listed = true }: { listed?: boolean } = {},
) {
  const { scripted, asked } = model(each, sentence, reply);
  const { core, client, mind } = await setUpWithDocuments(scripted, [each.file], {
    answerPaths: { asksForExactMarks: () => listed },
  });
  const answerId = await askNew(core, client, mind.id, each.question);
  const ended = await answerEnded(core, answerId);
  if (ended.event !== "finished") throw new Error("The Answer failed.");
  return {
    core,
    citation: onlyCitation(client, answerId),
    text: answerText(client, answerId),
    finished: ended.payload,
    asked,
  };
}

describe.each([
  ["en", RETURNS, NESTED_EN, PAGE_EN, "‘the “cooling-off period” lasts"],
  ["zh", ATTENTION, NESTED_ZH, PAGE_ZH, "‘注意力机制的灵活性来自于它的“软权重”特性"],
] as const)("Nested marks asked about once (%s)", (_, each, sentence, page, spliced) => {
  test("the reply with the Document's marks is taken: the quotation has them, and its card says so", async () => {
    const { citation, text, finished, asked } = await answer(each, sentence, quotes(page));
    expect(asked).toHaveLength(1);
    // The model reads the quotation in its sentence: the same words may mean another thing there.
    expect(asked[0]?.prompt).toContain(`Your sentence: ${sentence}`);
    expect(citation.check).toBe("found");
    expect(citation.quoteMarksChanged).toBe(true);
    expect(text).toContain(spliced);
    expect(finished.exactMarks).toMatchObject({ asked: 1, accepted: 1, declined: 0, failed: 0 });
  });

  test('"none" leaves the quotation as written, not found', async () => {
    const { citation, text, finished } = await answer(each, sentence, quotes(null));
    expect(citation).toMatchObject({
      check: "not-found",
      checkReason: "quoted-words-not-on-pages",
    });
    expect(citation.quoteMarksChanged).toBeUndefined();
    expect(text).not.toContain(spliced);
    expect(finished.exactMarks).toMatchObject({ asked: 1, accepted: 0, declined: 1 });
  });

  test("a reply that changes a word, or one the check doesn't find, is not taken", async () => {
    const changed = page.replace(/14|十四|灵活性/u, (found) =>
      found === "14" ? "15" : found === "十四" ? "十五" : "稳定性",
    );
    const { citation, finished } = await answer(each, sentence, quotes(changed));
    expect(citation.check).toBe("not-found");
    expect(finished.exactMarks).toMatchObject({ accepted: 0, rejected: 1 });
  });

  test("a reply that adds a pair of marks the quotation doesn't have is not taken", async () => {
    const { citation, finished } = await answer(each, sentence, quotes(`“${page}”`));
    expect(citation.check).toBe("not-found");
    expect(finished.exactMarks).toMatchObject({ accepted: 0, rejected: 1 });
  });

  test("a reply in marks of another kind than “ ” and ‘ ’ is not taken", async () => {
    const corners = page.replace("“", "「").replace("”", "」");
    const { citation, finished } = await answer(each, sentence, quotes(corners));
    expect(citation.check).toBe("not-found");
    expect(finished.exactMarks).toMatchObject({ rejected: 1, otherMarks: 0 });
  });

  test("on a model not listed for it, nothing is asked: not found, as before", async () => {
    const { citation, finished, asked } = await answer(each, sentence, quotes(page), {
      listed: false,
    });
    expect(asked).toHaveLength(0);
    expect(citation.check).toBe("not-found");
    expect(finished.exactMarks).toBeNull();
  });
});

describe("What the second reading never asks about", () => {
  test("the page's marks of another kind than “ ” and ‘ ’ there: not asked, counted", async () => {
    const plan: Case = {
      file: {
        name: "预案.md",
        contents: "# 预案\n\n若供应商错过六月交货，团队的「乙方案」随即启动，不再另行通知。\n",
      },
      query: "乙方案",
      question: "什么时候启动乙方案？",
      quote: "若供应商错过六月交货，团队的「乙方案」随即启动",
    };
    const { citation, asked, finished } = await answer(
      plan,
      "预案写道“若供应商错过六月交货，团队的‘乙方案’随即启动，不再另行通知”[^1]。",
      quotes("若供应商错过六月交货，团队的「乙方案」随即启动，不再另行通知"),
    );
    expect(asked).toHaveLength(0);
    expect(finished.exactMarks).toMatchObject({ secondReadings: 1, otherMarks: 1, asked: 0 });
    expect(citation.check).toBe("not-found");
  });

  test("an apostrophe stays a letter: “it’s fine” isn't read as the page's “its fine”", async () => {
    const plan: Case = {
      file: {
        name: "Review.md",
        contents: "# Review\n\nThe panel called the result “its fine print” and moved on.\n",
      },
      query: "panel result",
      question: "What did the panel call it?",
      quote: "The panel called the result “its fine print”",
    };
    const { citation, asked, finished } = await answer(
      plan,
      "It says “the panel called the result ‘it’s fine print’ and moved on”[^1].",
      quotes("the panel called the result “its fine print” and moved on"),
    );
    expect(asked).toHaveLength(0);
    expect(finished.exactMarks).toBeNull();
    expect(citation.check).toBe("not-found");
  });

  test("a matching quote isn't asked about", async () => {
    const { citation, asked } = await answer(
      RETURNS,
      "It says “the “cooling-off period” lasts 14 days” in its own words [^1].",
      quotes(PAGE_EN),
    );
    expect(asked).toHaveLength(0);
    expect(citation.check).not.toBe("not-found");
  });
});

test("an apostrophe in the words stays a letter: “it’s the ‘best’ plan” is asked about and taken", async () => {
  const plan: Case = {
    file: {
      name: "Plan.md",
      contents: "# Plan\n\nThe board agreed that it’s the “best” plan for the spring launch.\n",
    },
    query: "best plan",
    question: "What did the board agree?",
    quote: "The board agreed that it’s the “best” plan",
  };
  const { citation, asked, text } = await answer(
    plan,
    "The minutes say “the board agreed that it’s the ‘best’ plan for the spring launch”[^1].",
    quotes("the board agreed that it’s the “best” plan for the spring launch"),
  );
  expect(asked).toHaveLength(1);
  expect(citation.check).toBe("found");
  expect(text).toContain("‘the board agreed that it’s the “best” plan for the spring launch’");
});

describe("A phrase the page repeats", () => {
  const twice = (quote: string): Case => ({
    file: {
      name: "Terms.md",
      contents:
        "# Terms\n\nThe “service window” opens at nine on weekdays.\n\nRepairs are booked by phone. Parts are ordered by email.\n\nThe “service window” opens at nine on weekdays.\n",
    },
    query: "service window",
    question: "When does the service window open?",
    quote,
  });
  const sentence = "The terms say “the ‘service window’ opens at nine on weekdays”[^1].";
  const reply = quotes("the “service window” opens at nine on weekdays");

  test("the place nearest the record's own quote is the one asked about", async () => {
    const { citation, asked } = await answer(
      twice("Repairs are booked by phone. Parts are ordered by email.\n\nThe “service window”"),
      sentence,
      reply,
    );
    expect(asked).toHaveLength(1);
    expect(asked[0]?.prompt).toContain("The “service window” opens at nine on weekdays");
    expect(citation.check).toBe("found");
  });

  test("two places as near the record's quote: nothing is asked, not found", async () => {
    const { citation, asked, finished } = await answer(
      twice("Repairs are booked by phone. Parts are ordered by email"),
      sentence,
      reply,
    );
    expect(asked).toHaveLength(0);
    expect(finished.exactMarks).toBeNull();
    expect(citation.check).toBe("not-found");
  });
});

describe("Stopping, and failing", () => {
  test("Stop while the ask is out withdraws it: nothing is spliced", async () => {
    let release = () => {};
    const until = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { scripted, asked } = model(RETURNS, NESTED_EN, {
      ...quotes(PAGE_EN),
      pause: { after: 0, until },
    });
    const { core, client, mind } = await setUpWithDocuments(scripted, [RETURNS.file], {
      answerPaths: { asksForExactMarks: () => true },
    });
    const answerId = await askNew(core, client, mind.id, RETURNS.question);
    await expect.poll(() => asked.length).toBe(1);
    const ended = answerEnded(core, answerId);
    await core.stopAnswer({ mindId: mind.id, answerId });
    release();
    await ended;
    expect(answerText(client, answerId)).not.toContain("‘the “cooling-off period”");
    expect(onlyCitation(client, answerId).quoteMarksChanged).toBeUndefined();
  });

  test("a provider error on the ask leaves the quotation not found, as before", async () => {
    const { citation, finished } = await answer(RETURNS, NESTED_EN, {
      error: { status: 500, message: "Internal error" },
    });
    expect(citation.check).toBe("not-found");
    expect(finished.exactMarks).toMatchObject({ asked: 1, accepted: 0, failed: 1 });
  });
});

test("only a question's Answer asks: never a check's sentence, a Task or another flow", () => {
  const model = { catalogId: "deepseek", modelId: "deepseek-flash" };
  const listed = { asksForExactMarks: () => true };
  expect(asksForExactMarks(model, "question", listed)).toBe(true);
  for (const flow of ["check", "task-answer", "outside-agent", "call-help"] as const) {
    expect(asksForExactMarks(model, flow, listed)).toBe(false);
  }
  expect(asksForExactMarks(model, "question")).toBe(false);
});

describe("A reply applies only to the Answer it was asked about", () => {
  const page = "The “cooling-off period” lasts 14 days from delivery for every order.";
  const words = "the ‘cooling-off period’ lasts 14 days from delivery for every order";
  const quotation = `“${words}”`;
  const markdown = `It says ${quotation}[^1].`;
  const cited: CitedPages = {
    marker: 1,
    units: [{ page: 1, text: page }],
    matching: {},
    quoteAt: [{ start: 0, end: 20 }],
    version: "the Citation as asked about",
  };
  const taken = "the “cooling-off period” lasts 14 days from delivery for every order";

  const ask = (reply: ScriptedReply, changes: Partial<Parameters<typeof exactMarks>[0]> = {}) =>
    exactMarks({
      model: scriptedModel(() => reply),
      markdown,
      quotations: [{ words, markers: [1], quotation, sentence: markdown }],
      unfound: () => [cited],
      current: () => markdown,
      version: () => cited.version,
      holds: () => true,
      changed: () => {},
      signal: new AbortController().signal,
      ...changes,
    });

  test("as asked about, the reply is taken", async () => {
    const result = await ask(quotes(taken));
    expect(result?.markdown).toBe(`It says ‘${taken}’[^1].`);
    expect(result?.ask).toMatchObject({ accepted: 1, invalidated: 0 });
  });

  test("an edit since the ask, a marker [^1] made [^2], makes it stale", async () => {
    const result = await ask(quotes(taken), { current: () => markdown.replace("[^1]", "[^2]") });
    expect(result?.markdown).toBe(markdown);
    expect(result?.ask).toMatchObject({ accepted: 0, invalidated: 1 });
  });

  test("a Citation of another version since the ask makes it stale", async () => {
    const result = await ask(quotes(taken), { version: () => "the Document read again" });
    expect(result?.ask).toMatchObject({ accepted: 0, invalidated: 1 });
  });

  test("the quotation typed into in the Answer's place makes it stale", async () => {
    const result = await ask(quotes(taken), { holds: () => false });
    expect(result?.ask).toMatchObject({ accepted: 0, invalidated: 1 });
  });

  test("an id given twice is refused, and one it wasn't asked about is no reply", async () => {
    const twice = await ask({
      text: JSON.stringify({
        quotes: [
          { id: 1, quote: taken },
          { id: 1, quote: taken },
        ],
      }),
    });
    expect(twice?.ask).toMatchObject({ accepted: 0, rejected: 1 });
    const unknown = await ask({ text: JSON.stringify({ quotes: [{ id: 2, quote: taken }] }) });
    expect(unknown?.markdown).toBe(markdown);
    expect(unknown?.ask).toMatchObject({ accepted: 0, failed: 1 });
  });

  test("past its deadline the Answer goes on as if none had been asked", async () => {
    const result = await ask(
      { ...quotes(taken), pause: { after: 0, until: new Promise(() => {}) } },
      { deadlineMs: 50 },
    );
    expect(result?.markdown).toBe(markdown);
    expect(result?.ask).toMatchObject({ accepted: 0, failed: 1 });
  });

  test("Stop withdraws it: nothing comes back to apply", async () => {
    const stop = new AbortController();
    const pending = ask(
      { ...quotes(taken), pause: { after: 0, until: new Promise(() => {}) } },
      { signal: stop.signal },
    );
    stop.abort();
    expect(await pending).toBeNull();
  });
});
