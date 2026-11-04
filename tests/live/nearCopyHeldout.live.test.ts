/**
 * The held-out near copies (`nearCopyHeldout.cases.ts`, `nearCopyWalkShape.cases.ts`) on the check's
 * judge (#1765, #1766, #1708), through Check this Note as the window uses it. Each case is checked
 * on its own: its own Note, in a Library that holds only the one Document whose clause it copies,
 * so nothing else could back a decoy. The sorter is scripted to give each sentence as its case's
 * parts (one fact, or the wrong part and the probe), so the judge alone decides them: a sorter that
 * reads "should" as advice would leave the sentence unchecked, which says nothing of the judge.
 * Everything else is the real model, and every request is logged with its case, so each verdict
 * says which path decided it (the check's own verdict and fields, the judgements after it).
 *
 * Runs only with INCARNAMIND_LIVE_ANTHROPIC_KEY; the model is INCARNAMIND_LIVE_ANTHROPIC_MODEL
 * (Claude Haiku 5.5 by default), INCARNAMIND_LIVE_RUNS the checks of each case (1), and
 * INCARNAMIND_LIVE_LANGUAGES the languages (`en,zh-CN`). The report, every check with its path and
 * what each language spent, is written to INCARNAMIND_LIVE_REPORT when it is set.
 */
import { writeFile } from "node:fs/promises";
import { wrapLanguageModel } from "ai";
import { describe, expect, test } from "vitest";
import { marksOf, outcomeOf } from "../../eval/repeats/repeat";
import { type ChatModelChoice, type Core, createAiSdkChatModel } from "../../src/core";
import { createTempDataFolder, startCore } from "../helpers/core";
import { addAndProcess, writeSourceFile } from "../helpers/documents";
import { connectToMind } from "../helpers/mindClient";
import { note, writeMind } from "../helpers/minds";
import { NEAR_COPY_SETS, type NearCopyDocument } from "./nearCopyHeldout.cases";
import { WALK_SHAPE_SETS } from "./nearCopyWalkShape.cases";

const KEY = process.env.INCARNAMIND_LIVE_ANTHROPIC_KEY;
const MODEL = process.env.INCARNAMIND_LIVE_ANTHROPIC_MODEL ?? "claude-haiku-5-5";
const RUNS = Number(process.env.INCARNAMIND_LIVE_RUNS ?? 1) || 1;
const LANGUAGES = process.env.INCARNAMIND_LIVE_LANGUAGES?.split(",") ?? ["en", "zh-CN"];
const REPORT = process.env.INCARNAMIND_LIVE_REPORT;
/** Libraries checked at once; within one, its cases are checked one after another. */
const AT_ONCE = 3;

/** One case: a sentence, the parts the sorter gives it, and the part whose verdict is read. */
interface Case {
  key: string;
  kind: string;
  shape: "whole" | "walk";
  document: string;
  sentence: string;
  parts: readonly string[];
  probe: string;
  decoy: boolean;
}

interface Logged {
  kind: string;
  reply: string;
}

/** What a request is, from the instructions it carries. */
const KINDS: readonly (readonly [string, string])[] = [
  ["sort", "You sort the sentences of the User's own draft"],
  ["check", "You check one sentence the User wrote"],
  ["strict", "Reply in exactly three lines, in English"],
  ["confirm", "- conflict: they state different values"],
  ["nearest", "- conflict: both state a figure"],
  ["part", "says more than words quoted"],
  ["evidence", "without recording the Passage"],
  ["covered-evidence", "named the part of it that a Passage does state"],
];

const kindOf = (prompt: unknown): string => {
  const text = JSON.stringify(prompt);
  return KINDS.find(([, marker]) => text.includes(marker))?.[0] ?? "other";
};

/** The sort's sentences, from the request's own JSON: `{"sentences":[{"number":1,"text":"…"}]}`. */
function sortedSentences(prompt: unknown): { number: number; text: string }[] | null {
  for (const message of prompt as { role: string; content: unknown }[]) {
    if (message.role !== "user") continue;
    const text =
      typeof message.content === "string"
        ? message.content
        : (message.content as { type: string; text?: string }[])
            .map((part) => part.text ?? "")
            .join("");
    try {
      const value = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)) as {
        sentences?: { number: number; text: string }[];
      };
      if (Array.isArray(value.sentences)) return value.sentences;
    } catch {
      // Not the sort's input: another message of the request.
    }
  }
  return null;
}

/**
 * The real model for one Library, its sort answered from the cases without a request, and every
 * other request's reply logged into `log`, the case being checked.
 */
function loggingModel(cases: readonly Case[], log: () => Logged[]) {
  const createChatModel: NonNullable<Parameters<typeof startCore>[1]>["createChatModel"] = (spec) =>
    wrapLanguageModel({
      model: createAiSdkChatModel(spec),
      middleware: {
        specificationVersion: "v4",
        wrapGenerate: async ({ doGenerate, params }) => {
          const kind = kindOf(params.prompt);
          const asked = kind === "sort" ? sortedSentences(params.prompt) : null;
          if (asked) {
            const sentences = asked.map(({ number, text }) => ({
              number,
              parts: (cases.find((each) => each.sentence === text)?.parts ?? [text]).map(
                (part) => ({ kind: "fact", text: part }),
              ),
            }));
            return {
              content: [{ type: "text" as const, text: JSON.stringify({ sentences }) }],
              finishReason: { unified: "stop" as const, raw: undefined },
              usage: {
                inputTokens: { total: 0, noCache: 0, cacheRead: undefined, cacheWrite: undefined },
                outputTokens: { total: 0, text: 0, reasoning: undefined },
              },
              warnings: [],
            };
          }
          const result = await doGenerate();
          log().push({
            kind,
            reply: result.content.map((part) => (part.type === "text" ? part.text : "")).join(""),
          });
          return result;
        },
        wrapStream: async ({ doStream, params }) => {
          const kind = kindOf(params.prompt);
          const result = await doStream();
          let reply = "";
          const into = log();
          type Part = typeof result.stream extends ReadableStream<infer Each> ? Each : never;
          const heard = new TransformStream<Part, Part>({
            transform(part, controller) {
              if (part.type === "text-delta") reply += part.delta;
              controller.enqueue(part);
            },
            flush() {
              into.push({ kind, reply });
            },
          });
          return { ...result, stream: result.stream.pipeThrough(heard) };
        },
      },
    });
  return createChatModel;
}

/** A check reply's lines the code reads, and each judgement's word: what decided the verdict. */
function pathOf(logged: readonly Logged[]) {
  const checks = logged.filter((each) => each.kind === "check" && each.reply.trim() !== "");
  const fields = (checks.at(-1)?.reply ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^(?:verdict|scope|topic|roles|time|absence|evidence)\b/i.test(line))
    .concat(
      (checks.at(-1)?.reply ?? "")
        .split("\n")
        .filter((line) => /^\s*figures:/i.test(line))
        .map((line) => line.trim().slice(0, 400)),
    );
  return {
    requests: logged.map((each) => each.kind),
    fields,
    judgements: logged
      .filter((each) => each.kind !== "check")
      .map((each) => `${each.kind}: ${each.reply.trim().slice(0, 300)}`),
  };
}

const spentOf = async (core: Core) =>
  (await core.getCostSummary()).spent
    .filter((each) => each.currency === "USD")
    .reduce((total, each) => total + each.amount, 0);

interface Sample {
  outcome: string;
  /** The probe part's own verdict, for a sentence of two parts. */
  probe: string | null;
  says: string | null;
  quote: string | null;
  failure: string | null;
  path: ReturnType<typeof pathOf>;
}

/** Checks each case of one Document in a Library of that Document alone, each in a Note of its own. */
async function checkLibrary(
  language: "en" | "zh-CN",
  document: NearCopyDocument,
  cases: readonly Case[],
): Promise<{ results: { case: Case; samples: Sample[] }[]; spent: number }> {
  let logged: Logged[] = [];
  const core = startCore(await createTempDataFolder(), {
    createChatModel: loggingModel(cases, () => logged),
  });
  core.on("consent.requested", (asked) => void core.respondToConsent(asked.requestId, true));
  await core.updateSettings({
    user: { language, monthlyCap: { amount: 5, currency: "USD" } },
  });
  const provider = await core.saveChatProvider({
    kind: "anthropic",
    apiKey: KEY ?? "",
    modelId: MODEL,
  });
  const model: ChatModelChoice = { providerId: provider.id, modelId: MODEL };
  const sources = await createTempDataFolder();
  const file = await writeSourceFile(
    sources,
    document.file,
    `# ${document.title}\n\n${document.clauses.map((clause, index) => `${index + 1}. ${clause}`).join("\n")}\n`,
  );
  await addAndProcess(core, [file]);
  const results = [];
  for (const each of cases) {
    const { id: mindId } = await core.createMind({ title: each.key, folderId: null });
    const client = await connectToMind(core, mindId);
    writeMind(client, [note(each.sentence)]);
    await client.settled();
    const samples: Sample[] = [];
    for (let run = 1; run <= RUNS; run++) {
      logged = [];
      const mode = run === 1 ? "changed" : "all";
      const requestId = `${mindId}-${run}`;
      if (run === 1)
        await core.findMindClaims({ requestId: `${requestId}-claims`, mindId, mode, model });
      await core.checkMind({ requestId, mindId, mode, model });
      const check = (await marksOf(core, mindId)).find(
        (mark) => mark.sentence === each.sentence,
      )?.check;
      const probe =
        each.shape === "walk"
          ? (check?.parts?.find(
              (part) => each.sentence.slice(part.span.start, part.span.end) === each.probe,
            )?.verdict ?? "no-part")
          : null;
      samples.push({
        outcome: outcomeOf(check),
        probe,
        says: check?.says ?? check?.unsupported?.reason ?? null,
        quote: check?.evidence?.quote ?? null,
        failure:
          check?.state === "not-checked"
            ? [check.reason, check.detail].filter(Boolean).join(": ")
            : null,
        path: pathOf(logged),
      });
    }
    console.log(
      `${MODEL} ${language} ${each.document} ${each.key}${each.decoy ? " (decoy)" : ""}: ${samples.map((sample) => sample.probe ?? sample.outcome).join(",")}`,
    );
    results.push({ case: each, samples });
  }
  return { results, spent: await spentOf(core) };
}

/** Whether a sample reads Supported: the probe part's verdict for a sentence of two parts. */
const supported = (sample: Sample) => (sample.probe ?? sample.outcome) === "supported";

describe("held-out near copies on the judge", () => {
  test.skipIf(KEY === undefined)(
    "refuses a changed period, duty or dropped condition, and backs the true copies",
    { timeout: 3 * 3_600_000 },
    async () => {
      const report = [];
      for (const set of NEAR_COPY_SETS.filter((each) => LANGUAGES.includes(each.language))) {
        const walks = WALK_SHAPE_SETS.find((each) => each.language === set.language)?.cases ?? [];
        const cases: Case[] = [
          ...set.cases.map((each) => ({
            key: each.key,
            kind: each.kind,
            shape: "whole" as const,
            document: each.document,
            sentence: each.text,
            parts: [each.text],
            probe: each.text,
            decoy: each.decoy,
          })),
          ...walks.map((each) => ({
            key: `walk-${each.key}`,
            kind: each.kind,
            shape: "walk" as const,
            document: each.document,
            sentence: each.sentence,
            parts: each.parts,
            probe: each.parts[1],
            decoy: each.decoy,
          })),
        ];
        for (const each of cases) {
          expect(each.parts.every((part) => each.sentence.includes(part))).toBe(true);
        }
        const libraries = [...set.documents];
        const done: Awaited<ReturnType<typeof checkLibrary>>[] = [];
        while (libraries.length > 0) {
          const batch = libraries.splice(0, AT_ONCE);
          done.push(
            ...(await Promise.all(
              batch.map((document) =>
                checkLibrary(
                  set.language,
                  document,
                  cases.filter((each) => each.document === document.key),
                ),
              ),
            )),
          );
        }
        const results = done.flatMap((each) => each.results);
        const spent = done.reduce((total, each) => total + each.spent, 0);
        const groups = new Map<string, { checks: number; supported: number }>();
        for (const { case: each, samples } of results) {
          const name = `${each.decoy ? "decoy" : "positive"} ${each.shape} ${each.kind}`;
          const row = groups.get(name) ?? { checks: 0, supported: 0 };
          row.checks += samples.length;
          row.supported += samples.filter(supported).length;
          groups.set(name, row);
        }
        const summary = {
          model: MODEL,
          language: set.language,
          runs: RUNS,
          groups: Object.fromEntries(groups),
          notChecked: results
            .flatMap((each) => each.samples)
            .filter((sample) => sample.outcome === "not-checked" || sample.outcome === "no-mark")
            .length,
          spent,
        };
        console.log(JSON.stringify(summary));
        report.push({ ...summary, results });
        expect(results.every((each) => each.samples.length === RUNS)).toBe(true);
      }
      if (REPORT) await writeFile(REPORT, JSON.stringify(report, null, 2));
    },
  );
});
