/**
 * Every model call sets its output limit from the one table (src/core/providers/outputLimits.ts,
 * #2275), so no reply can run to its provider's default, up to 128,000 tokens on Claude. A reply
 * that reaches its limit is cut short wherever it is made: an Answer says so, a check is Not
 * checked, never Supported. Through the core's public interface, with scripted models.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import type { MockLanguageModelV4 } from "ai/test";
import { describe, expect, test } from "vitest";
import type { Core, SaveChatProviderInput } from "../../src/core";
import {
  type ModelCallKind,
  OUTPUT_LIMITS,
  outputTokens,
} from "../../src/core/providers/outputLimits";
import { ANSWER_PROBLEMS } from "../../src/renderer/src/problems";
import { type MessageKey, translate } from "../../src/shared/i18n";
import { checkGenerate, checkReply, type Plan } from "../helpers/checks";
import { answerEnded, askAndFinish, askNew, setUpWithDocuments } from "../helpers/citations";
import { createTempDataFolder, startCore } from "../helpers/core";
import { addAndProcess, writeSourceFile } from "../helpers/documents";
import { note, question, writeMind } from "../helpers/minds";
import {
  type GenerateCall,
  type GeneratedReply,
  type ModelCall,
  type ScriptedReply,
  scriptedModel,
  scriptedModels,
} from "../helpers/models";
import { taggingModel, waitForTagging } from "../helpers/tags";

const ROOT = join(__dirname, "../..");

type Options = MockLanguageModelV4["doStreamCalls"][number];

const systemOf = (options: Options) =>
  options.prompt
    .filter((message) => message.role === "system")
    .map((message) => (typeof message.content === "string" ? message.content : ""))
    .join("\n");

/** The kinds a request of these instructions may be, as each call site names its own. */
const KINDS: readonly [RegExp, readonly ModelCallKind[]][] = [
  [/^You check one sentence/, ["check-step"]],
  [/^You turn a Question from the User's notebook/, ["search-query"]],
  [/^You translate a query/, ["search-query"]],
  [/^You check an AI assistant's reply/, ["claimed-changes"]],
  [/^You add the Citations an Answer left out/, ["unmarked-quotes"]],
  [/^You fix the quotes/, ["quote-retry"]],
  [/^You fix the calculated figures/, ["figure-retry"]],
  [/^Read the whole Documents/, ["absence-read"]],
  [/^You checked a sentence the User wrote/, ["evidence"]],
  [/^Compare a sentence/, ["comparison", "record-cite"]],
  [/^You sort the sentences/, ["find-claims"]],
  [/^You sort Documents with Tags/, ["tags"]],
];

/** What a request of `kind` may be limited to: its own most, or its share for 1 to 10 items. */
const limitsOf = (kind: ModelCallKind) =>
  "each" in OUTPUT_LIMITS[kind]
    ? Array.from({ length: 10 }, (_, index) => outputTokens(kind, index + 1))
    : [outputTokens(kind)];

/**
 * Each request the model was sent that set no limit from the table for its kind, or whose kind
 * isn't known here. A streamed request of no other kind is an Answer's: its Run's last step, one
 * written without Tools, or any other step of its Run.
 */
function unlimited(model: MockLanguageModelV4): string[] {
  const kindsOf = (options: Options, streamed: boolean): readonly ModelCallKind[] => {
    const system = systemOf(options);
    const known = KINDS.find(([pattern]) => pattern.test(system))?.[1];
    if (known) return known;
    if (!streamed) return [];
    const last = JSON.stringify(options.prompt).includes("You can make no more calls");
    return last || !options.tools?.length ? ["answer"] : ["answer-step"];
  };
  const calls = [
    ...model.doStreamCalls.map((options) => ({ options, streamed: true })),
    ...model.doGenerateCalls.map((options) => ({ options, streamed: false })),
  ];
  return calls.flatMap(({ options, streamed }) => {
    const kinds = kindsOf(options, streamed);
    const allowed = kinds.flatMap(limitsOf);
    if (options.maxOutputTokens !== undefined && allowed.includes(options.maxOutputTokens))
      return [];
    return [
      `${kinds.join(" or ") || "an unknown call"} (${systemOf(options).slice(0, 60)}…): ${options.maxOutputTokens}`,
    ];
  });
}

const SPRING = "Spring tides come at new and full moon, when the sun and moon pull together.";
const TIDES = { name: "Tides.md", contents: `# Tides\n\n${SPRING}\n` };

const SALARY = "The salary is 61,500 per year, paid monthly.";
const FIGURE_CLAIM = "The salary is 61,500 per year.";
const ABSENCE_CLAIM = "The lease has no break clause.";
const TERM = "The lease runs for three years.";
const LEASE = { name: "Lease.md", contents: `# Lease\n\n${TERM}\n\n${SALARY}\n` };

/** A whole read that finds nothing of what the sentence says is absent. */
const HOLDS = { absent: "break clause", absence: "holds" };

const PLANS: Record<string, Plan> = {
  [FIGURE_CLAIM]: { verdict: "supported", quote: SALARY },
  [TERM]: { verdict: "supported", quote: TERM },
  [ABSENCE_CLAIM]: { verdict: "supported", absence: true },
};

/** A reply whose text is written, cut off at its limit: what an Answer or a verdict ends with. */
const cut = (reply: ScriptedReply): ScriptedReply =>
  "text" in reply && reply.text && !reply.calls ? { ...reply, cutOff: true } : reply;

/** A model that checks as `PLANS` say; `cutVerdict`: its verdict is cut off; `cutRead`: so is a whole read. */
function checkModel({ cutVerdict = false, cutRead = false } = {}) {
  return scriptedModel(
    (call) => {
      const reply = checkReply(call, PLANS);
      return cutVerdict ? cut(reply) : reply;
    },
    {
      generate: (call: GenerateCall): GeneratedReply =>
        call.system.startsWith("Read the whole Documents")
          ? { text: JSON.stringify(HOLDS), cutOff: cutRead }
          : checkGenerate(PLANS)(call),
    },
  );
}

/** A model that calls Tools: it searches, cites what it found, then writes its Answer. */
function citing({ cutSearch = false, cutAnswer = false } = {}) {
  return scriptedModel((call: ModelCall): ScriptedReply => {
    const searched = call.results.find((result) => result.tool === "search_documents");
    if (!searched) {
      return {
        calls: [{ tool: "search_documents", input: { query: "spring tides" } }],
        cutOff: cutSearch,
      };
    }
    if (!call.results.some((result) => result.tool === "cite")) {
      const passage = /<passage id="([^"]+)"/.exec(searched.text)?.[1];
      return {
        calls: [{ tool: "cite", input: { citations: [{ marker: 1, passage, quote: SPRING }] } }],
      };
    }
    return { text: "Spring tides come at new and full moon [^1].", cutOff: cutAnswer };
  });
}

/** A model that can't call Tools: it answers in JSON, and translates queries; `cutQuery`: its query is cut off. */
function withoutTools({ cutQuery = false } = {}) {
  return scriptedModel(
    (call) =>
      call.tools.length > 0
        ? { error: { status: 400, message: "tiny:latest does not support tools" } }
        : { text: JSON.stringify({ answer: "At new and full moon.", citations: [] }) },
    { generate: () => ({ text: "When do spring tides happen?", cutOff: cutQuery }) },
  );
}

const LOCAL: SaveChatProviderInput = { kind: "ollama", modelId: "local-model" };

async function tagged(model: MockLanguageModelV4) {
  const core = startCore(await createTempDataFolder(), {
    createChatModel: scriptedModels(model).createChatModel,
  });
  await core.saveChatProvider(LOCAL);
  const [document] = await addAndProcess(core, [
    await writeSourceFile(await createTempDataFolder(), "Attention.md", "Attention. A paper."),
  ]);
  if (!document) throw new Error("Nothing was added.");
  const [done] = await waitForTagging(
    core,
    [document.id],
    (each) => each.tagging === "tagged" || each.tagging === "failed",
  );
  return { core, document: done };
}

/** The words of `key` in both languages, as the interface shows them. */
const inBoth = (key: MessageKey) => [translate("en", key), translate("zh-CN", key)];

async function failedAnswer(core: Core, client: Parameters<typeof askNew>[1], mindId: string) {
  const answerId = await askNew(core, client, mindId, "When are spring tides?");
  return answerEnded(core, answerId);
}

describe("Every model call's output limit", () => {
  /** The core's source files, but its tests. */
  const sources = (folder: string): { path: string; text: string }[] =>
    readdirSync(folder).flatMap((name) => {
      const path = join(folder, name);
      if (statSync(path).isDirectory()) return sources(path);
      if (!/\.ts$/.test(name) || /\.test\.ts$/.test(name)) return [];
      return [
        { path: relative(ROOT, path).split(sep).join("/"), text: readFileSync(path, "utf8") },
      ];
    });

  /** The object literal that opens at `from`, braces balanced. */
  const literalAt = (text: string, from: number) => {
    let depth = 0;
    for (let at = from; at < text.length; at++) {
      if (text[at] === "{") depth++;
      else if (text[at] === "}" && --depth === 0) return text.slice(from, at + 1);
    }
    return text.slice(from);
  };

  // protects=no model call in the core is left to its provider's default output (128,000 tokens on Claude), and none sets a number of its own; fails_when=a call to the AI SDK sets no maxOutputTokens, or one not read from the table (#2275).
  test("every call to the model layer in the core sets one, read from the table", () => {
    const fromTable =
      /^(?:outputTokens\(|outputOf\(|request\.outputTokens\.|call\.maxOutputTokens)/;
    const found: string[] = [];
    const missing: string[] = [];
    for (const file of sources(join(ROOT, "src/core"))) {
      for (const match of file.text.matchAll(
        /\b(?:generateText|streamText|generateObject|streamObject)\(\{/g,
      )) {
        const line = file.text.slice(0, match.index).split("\n").length;
        found.push(`${file.path}:${line}`);
        const limit = /\bmaxOutputTokens\b(?:\s*:\s*([^,\n]+))?/.exec(
          literalAt(file.text, match.index + match[0].length - 1),
        );
        const read = limit && (limit[1] === undefined || fromTable.test(limit[1].trim()));
        if (!read || !/outputLimits|request\.outputTokens/.test(file.text)) {
          missing.push(`${file.path}:${line}`);
        }
      }
    }
    expect(found.length).toBeGreaterThan(20);
    expect(missing).toEqual([]);
  });

  // protects=an Answer's Run asks each step for no more than the table's step limit, and its writing for the Answer's; fails_when=a step's request sets none, as the Run's other steps did (#2275).
  test("an Answer with Citations: each step of its Run", async () => {
    const model = citing();
    const { core, client, mind } = await setUpWithDocuments(model, [TIDES]);

    await askAndFinish(core, client, mind.id, "When are spring tides?");

    expect(model.doStreamCalls.length).toBeGreaterThanOrEqual(3);
    expect(model.doStreamCalls[0]?.maxOutputTokens).toBe(outputTokens("answer-step"));
    expect(unlimited(model)).toEqual([]);
  });

  test("an Answer's Run that searches to its last step: the last step writes within the Answer's limit", async () => {
    const model = scriptedModel((call) =>
      JSON.stringify(call.options.prompt).includes("You can make no more calls")
        ? { text: "I read some of the Documents, and didn't check the rest." }
        : {
            calls: [{ tool: "search_documents", input: { query: `tides ${call.results.length}` } }],
          },
    );
    const { core, client, mind } = await setUpWithDocuments(model, [TIDES]);

    await askAndFinish(core, client, mind.id, "When are spring tides?");

    const limits = model.doStreamCalls.map((call) => call.maxOutputTokens);
    expect(limits.at(-1)).toBe(outputTokens("answer"));
    expect(limits.slice(0, -1)).toEqual(limits.slice(0, -1).map(() => outputTokens("answer-step")));
    expect(unlimited(model)).toEqual([]);
  });

  test("an Answer without Tools: its rewritten and translated search queries, and the Answer", async () => {
    const model = withoutTools();
    const { core, client, mind } = await setUpWithDocuments(model, [TIDES]);
    const asked = question("大潮在什么时候发生？");
    writeMind(client, [note("关于潮汐的笔记。"), asked]);
    await client.settled();

    const result = await core.askQuestion({ mindId: mind.id, questionId: asked.attrs.id });
    if (!result.asked) throw new Error("The Question wasn't asked.");
    expect((await answerEnded(core, result.answerId)).event).toBe("finished");

    expect(model.doGenerateCalls.length).toBeGreaterThanOrEqual(2);
    expect(unlimited(model)).toEqual([]);
  });

  test("a check of a sentence with a figure, of one with none, and of an absence, with its whole read", async () => {
    const model = checkModel();
    const { core } = await setUpWithDocuments(model, [LEASE]);

    for (const claim of [FIGURE_CLAIM, TERM, ABSENCE_CLAIM]) {
      expect(await core.checkClaim({ claim }), claim).toMatchObject({ verdict: "supported" });
    }

    expect(
      model.doGenerateCalls.filter((call) => systemOf(call).startsWith("Read the whole")),
    ).toHaveLength(1);
    expect(unlimited(model)).toEqual([]);
  });

  test("tag classification", async () => {
    const tagging = taggingModel(["Paper"]);

    const { document } = await tagged(tagging.model);

    expect(document?.tagging).toBe("tagged");
    expect(tagging.model.doGenerateCalls.map((call) => call.maxOutputTokens)).toEqual([
      outputTokens("tags"),
    ]);
  });
});

describe("A reply cut at its limit", () => {
  // protects=an Answer whose reply reached its limit says so, in English and Chinese, and isn't shown as a whole Answer; fails_when=it finishes as if whole (#2275).
  test("ends an Answer with the cut-short line, where a whole one finishes", async () => {
    const whole = await setUpWithDocuments(citing(), [TIDES]);
    await askAndFinish(whole.core, whole.client, whole.mind.id, "When are spring tides?");

    const { core, client, mind } = await setUpWithDocuments(citing({ cutAnswer: true }), [TIDES]);
    const ended = await failedAnswer(core, client, mind.id);

    expect(ended).toMatchObject({ event: "failed", payload: { error: { kind: "cut-short" } } });
    expect(ANSWER_PROBLEMS["cut-short"].line).toBe("answer.error.cut-short");
    for (const words of inBoth("answer.error.cut-short")) {
      expect(words).not.toBe("answer.error.cut-short");
      expect(words.length).toBeGreaterThan(0);
    }
  });

  // protects=a step of a Run cut at its limit ends the Run there: no Tool call it was writing is made, and the Answer says it was cut short; fails_when=the Run goes on to another step, or retries (#2275).
  test("ends a Run at any step: nothing is asked again", async () => {
    const model = citing({ cutSearch: true });
    const { core, client, mind } = await setUpWithDocuments(model, [TIDES]);

    const ended = await failedAnswer(core, client, mind.id);

    expect(ended).toMatchObject({ event: "failed", payload: { error: { kind: "cut-short" } } });
    expect(model.doStreamCalls).toHaveLength(1);
  });

  // protects=a check whose verdict was cut at its limit is Not checked, never Supported, with and without figures, and says why in English and Chinese; fails_when=the cut verdict is read as whole (#2275).
  test("leaves a check Not checked, where a whole verdict stands", async () => {
    const whole = await setUpWithDocuments(checkModel(), [LEASE]);
    const { core } = await setUpWithDocuments(checkModel({ cutVerdict: true }), [LEASE]);

    for (const claim of [FIGURE_CLAIM, TERM]) {
      expect(await whole.core.checkClaim({ claim }), claim).toMatchObject({
        verdict: "supported",
      });
      expect(await core.checkClaim({ claim }), claim).toMatchObject({
        verdict: "not-checked",
        reason: "cut-short",
      });
    }
    for (const words of inBoth("claim.reason.cut-short")) {
      expect(words).not.toBe("claim.reason.cut-short");
    }
  });

  // protects=a whole read cut at its limit decides nothing: the absence is Not checked, not Supported; fails_when=the start of a cut reply, "holds", is taken (#2275).
  test("leaves an absence Not checked when its whole read was cut, where a whole read decides it", async () => {
    const whole = await setUpWithDocuments(checkModel(), [LEASE]);
    const model = checkModel({ cutRead: true });
    const { core } = await setUpWithDocuments(model, [LEASE]);

    expect(await whole.core.checkClaim({ claim: ABSENCE_CLAIM })).toMatchObject({
      verdict: "supported",
    });
    expect(await core.checkClaim({ claim: ABSENCE_CLAIM })).toMatchObject({
      verdict: "not-checked",
      reason: "cut-short",
    });
    // Not asked again at a higher limit, nor at the same one.
    expect(
      model.doGenerateCalls.filter((call) => systemOf(call).startsWith("Read the whole")),
    ).toHaveLength(1);
  });

  test("tags nothing, and says so in English and Chinese", async () => {
    const tagging = taggingModel(["Paper"]);
    const cutOff = scriptedModel(() => ({ text: "" }), {
      generate: () => ({ text: '{"tags":["Pa', cutOff: true }),
    });

    expect((await tagged(tagging.model)).document?.tagging).toBe("tagged");
    const { document } = await tagged(cutOff);

    expect(document).toMatchObject({ tagging: "failed", taggingError: { kind: "cut-short" } });
    for (const words of inBoth("tagging.problem.cut-short")) {
      expect(words).not.toBe("tagging.problem.cut-short");
    }
  });

  test("leaves a translated search query out: the Question is searched as asked", async () => {
    const searches = async (model: MockLanguageModelV4) => {
      const { core, client, mind } = await setUpWithDocuments(model, [TIDES]);
      const queries: unknown[] = [];
      core.on("answer.toolCallStarted", (event) => queries.push(event.call.input.query));
      await askAndFinish(core, client, mind.id, "大潮在什么时候发生？");
      return queries;
    };

    expect(await searches(withoutTools())).toEqual([
      "大潮在什么时候发生？",
      "When do spring tides happen?",
    ]);
    expect(await searches(withoutTools({ cutQuery: true }))).toEqual(["大潮在什么时候发生？"]);
  });
});
