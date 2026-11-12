/**
 * The held-out near copies (`nearCopyHeldout.cases.ts`, `nearCopyWalkShape.cases.ts`,
 * `nearCopyConfirmed.cases.ts` and the changes of `nearCopyAmended.cases.ts`) on the check's judge
 * (#1765, #1766, #1708), through Check this Note on the core, with the test core's fake embedding
 * and reranking models: with one short Document in each Library, they decide no search. Each case is checked
 * on its own: its own Note, in a Library that holds only the one Document whose clause it copies,
 * so nothing else could back a decoy. The sorter is scripted to give each sentence as its case's
 * parts (one fact, or the wrong part and the probe), so the judge alone decides them: a sorter that
 * reads "should" as advice would leave the sentence unchecked, which says nothing of the judge.
 * Everything else is the real model, and every request is logged with its case, so each verdict
 * says which path decided it (the check's own verdict and fields, the judgements after it). Its bars
 * are about verdicts, so each check of a case is a Note of its own, sorted afresh, and the report
 * counts a case's sorts beside its checks (#2964).
 *
 * Runs only with INCARNAMIND_LIVE_ANTHROPIC_KEY; the model is INCARNAMIND_LIVE_ANTHROPIC_MODEL
 * (Claude Haiku 5.5 by default), INCARNAMIND_LIVE_RUNS the checks of each case (1),
 * INCARNAMIND_LIVE_LANGUAGES the languages (`en,zh-CN`), INCARNAMIND_LIVE_CASES the files to run,
 * by origin (`held-out,two-part,reported,amended,beyond,second-look,condition-forms,ask-paths,root-cause`; all of them when unset),
 * INCARNAMIND_LIVE_DOCUMENTS the Documents whose cases run, by key (all when unset), and
 * INCARNAMIND_LIVE_BUDGET the dollars after which no further
 * case starts (3), at the app's own count. The report, every check with its path and each part's
 * verdict and quote, is written to INCARNAMIND_LIVE_REPORT when it is set.
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
import { AMENDED_SETS } from "./nearCopyAmended.cases";
import { ASK_PATHS_SETS } from "./nearCopyAskPaths.cases";
import { BEYOND_EXAMPLES_SETS } from "./nearCopyBeyondExamples.cases";
import { CONDITION_FORMS_SETS } from "./nearCopyConditionForms.cases";
import { CONFIRMED_SETS } from "./nearCopyConfirmed.cases";
import { NEAR_COPY_SETS, type NearCopyDocument } from "./nearCopyHeldout.cases";
import { ROOT_CAUSE_SETS } from "./nearCopyRootCause.cases";
import { SECOND_LOOK_SETS } from "./nearCopySecondLook.cases";
import { WALK_SHAPE_SETS } from "./nearCopyWalkShape.cases";

const KEY = process.env.INCARNAMIND_LIVE_ANTHROPIC_KEY;
const MODEL = process.env.INCARNAMIND_LIVE_ANTHROPIC_MODEL ?? "claude-haiku-5-5";
const RUNS = Number(process.env.INCARNAMIND_LIVE_RUNS ?? 1) || 1;
const LANGUAGES = process.env.INCARNAMIND_LIVE_LANGUAGES?.split(",") ?? ["en", "zh-CN"];
const REPORT = process.env.INCARNAMIND_LIVE_REPORT;
type Origin =
  | "held-out"
  | "two-part"
  | "reported"
  | "amended"
  | "beyond"
  | "second-look"
  | "condition-forms"
  | "ask-paths"
  | "root-cause";
const ORIGINS = process.env.INCARNAMIND_LIVE_CASES?.split(",") ?? null;
const DOCUMENTS = process.env.INCARNAMIND_LIVE_DOCUMENTS?.split(",") ?? null;
const BUDGET = Number(process.env.INCARNAMIND_LIVE_BUDGET ?? 3) || 3;
/** Libraries checked at once; within one, its cases are checked one after another. */
const AT_ONCE = 3;

/** One case: a sentence, the parts the sorter gives it, and the part whose verdict is read. */
interface Case {
  key: string;
  kind: string;
  /** One fact, two parts with a probe, or one of the misses reported on the issues. */
  shape: "whole" | "walk" | "confirmed";
  /** The file it comes from: the reported misses of every file are "reported". */
  origin: Origin;
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

/** Each check reply's lines the code reads, and each judgement's word: what decided the verdict. */
function pathOf(logged: readonly Logged[]) {
  const read = (reply: string) =>
    reply
      .split("\n")
      .map((line) => line.trim())
      .filter((line) =>
        /^(?:verdict|scope|topic|roles|time|duty|condition|absence|evidence|figures)\b/i.test(line),
      )
      .map((line) => line.slice(0, 400));
  return {
    requests: logged.map((each) => each.kind),
    replies: logged
      .filter((each) => each.kind === "check" && read(each.reply).length > 0)
      .map((each) => read(each.reply)),
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
  /** The sort this check rests on: each check of a case sorts in a Note of its own. */
  sort: number;
  outcome: string;
  /** The probe part's own verdict, for a sentence of two parts. */
  probe: string | null;
  /** Each part's verdict and the quote it rests on, for a sentence of two parts. */
  parts: { text: string; verdict: string | null; quote: string | null }[];
  says: string | null;
  quote: string | null;
  failure: string | null;
  path: ReturnType<typeof pathOf>;
}

/** What every Library of the run has spent so far, at the app's own count. */
const live = new Set<Core>();
let finished = 0;
const spentSoFar = async () =>
  finished + (await Promise.all([...live].map(spentOf))).reduce((total, each) => total + each, 0);

/**
 * Checks each case of one Document in a Library of that Document alone, each in a Note of its own;
 * a case that would start past the run's budget isn't checked.
 */
async function checkLibrary(
  language: "en" | "zh-CN",
  document: NearCopyDocument,
  cases: readonly Case[],
): Promise<{ results: { case: Case; samples: Sample[] }[]; spent: number; skipped: string[] }> {
  let logged: Logged[] = [];
  const core = startCore(await createTempDataFolder(), {
    createChatModel: loggingModel(cases, () => logged),
  });
  live.add(core);
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
  const skipped: string[] = [];
  for (const each of cases) {
    if ((await spentSoFar()) >= BUDGET) {
      skipped.push(each.key);
      continue;
    }
    const samples: Sample[] = [];
    for (let run = 1; run <= RUNS; run++) {
      const { id: mindId } = await core.createMind({ title: each.key, folderId: null });
      const client = await connectToMind(core, mindId);
      writeMind(client, [note(each.sentence)]);
      await client.settled();
      logged = [];
      const requestId = `${mindId}-${run}`;
      await core.findMindClaims({
        requestId: `${requestId}-claims`,
        mindId,
        mode: "changed",
        model,
      });
      await core.checkMind({ requestId, mindId, mode: "changed", model });
      const check = (await marksOf(core, mindId)).find(
        (mark) => mark.sentence === each.sentence,
      )?.check;
      const parts = (check?.parts ?? []).map((part) => ({
        text: each.sentence.slice(part.span.start, part.span.end),
        verdict: part.verdict,
        quote: part.evidence[0]?.quote ?? null,
      }));
      const probe =
        each.shape === "walk"
          ? (parts.find((part) => part.text === each.probe)?.verdict ?? "no-part")
          : null;
      samples.push({
        sort: run,
        outcome: outcomeOf(check),
        probe,
        parts: each.shape === "walk" ? parts : [],
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
  const spent = await spentOf(core);
  live.delete(core);
  finished += spent;
  return { results, spent, skipped };
}

/** What a sample reads: the probe part's verdict for a sentence of two parts, else the card's. */
const readAs = (sample: Sample) => sample.probe ?? sample.outcome;
const supported = (sample: Sample) => readAs(sample) === "supported";
/** A check that settled nothing for the case: Not checked, or a probe that ended without its part. */
const unsettled = (sample: Sample) =>
  ["not-checked", "no-mark", "no-part"].includes(readAs(sample));

describe("held-out near copies on the judge", () => {
  test.skipIf(KEY === undefined)(
    "refuses a changed period, duty or dropped condition, and backs the true copies",
    { timeout: 3 * 3_600_000 },
    async () => {
      const report = [];
      for (const set of NEAR_COPY_SETS.filter((each) => LANGUAGES.includes(each.language))) {
        const walks = WALK_SHAPE_SETS.find((each) => each.language === set.language)?.cases ?? [];
        const confirmed = CONFIRMED_SETS.find((each) => each.language === set.language);
        const amended = AMENDED_SETS.find((each) => each.language === set.language);
        const earlier: Case[] = [
          ...set.cases.map((each) => ({
            key: each.key,
            kind: each.kind,
            shape: "whole" as const,
            origin: "held-out" as const,
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
            origin: "two-part" as const,
            document: each.document,
            sentence: each.sentence,
            parts: each.parts,
            probe: each.parts[1],
            decoy: each.decoy,
          })),
          ...(confirmed?.cases ?? []).map((each) => ({
            key: each.key,
            kind: each.kind,
            shape: "confirmed" as const,
            origin: "reported" as const,
            document: each.document,
            sentence: each.text,
            parts: [each.text],
            probe: each.text,
            decoy: each.decoy,
          })),
        ].filter((each) => !amended?.withdrawn.includes(each.key));
        const added: Case[] = (amended?.cases ?? []).map((each) => ({
          key: each.key,
          kind: each.kind,
          shape: each.twoPart ? "walk" : each.reported ? "confirmed" : "whole",
          origin: each.reported ? "reported" : "amended",
          document: each.document,
          sentence: each.text,
          parts: each.twoPart ?? [each.text],
          probe: each.twoPart?.[1] ?? each.text,
          decoy: each.decoy,
        }));
        const beyond = BEYOND_EXAMPLES_SETS.find((each) => each.language === set.language);
        const beyondCases: Case[] = (beyond?.cases ?? []).map((each) => ({
          key: `beyond-${each.key}`,
          kind: each.kind,
          shape: "whole",
          origin: "beyond",
          document: `beyond-${each.document}`,
          sentence: each.text,
          parts: [each.text],
          probe: each.text,
          decoy: each.decoy,
        }));
        const look = SECOND_LOOK_SETS.find((each) => each.language === set.language);
        const lookCases: Case[] = (look?.cases ?? []).map((each) => ({
          key: `look-${each.key}`,
          kind: each.kind,
          shape: each.twoPart ? "walk" : "whole",
          origin: "second-look",
          document: `look-${each.document}`,
          sentence: each.text,
          parts: each.twoPart ?? [each.text],
          probe: each.twoPart?.[1] ?? each.text,
          decoy: each.decoy,
        }));
        const forms = CONDITION_FORMS_SETS.find((each) => each.language === set.language);
        const formCases: Case[] = (forms?.cases ?? []).map((each) => ({
          key: `forms-${each.key}`,
          kind: each.kind,
          shape: "whole",
          origin: "condition-forms",
          document: `forms-${each.document}`,
          sentence: each.text,
          parts: [each.text],
          probe: each.text,
          decoy: each.decoy,
        }));
        const asks = ASK_PATHS_SETS.find((each) => each.language === set.language);
        const askCases: Case[] = (asks?.cases ?? []).map((each) => ({
          key: `asks-${each.key}`,
          kind: each.kind,
          shape: "whole",
          origin: "ask-paths",
          document: `asks-${each.document}`,
          sentence: each.text,
          parts: [each.text],
          probe: each.text,
          decoy: each.decoy,
        }));
        const roots = ROOT_CAUSE_SETS.find((each) => each.language === set.language);
        const rootCases: Case[] = (roots?.cases ?? []).map((each) => ({
          key: `root-${each.key}`,
          kind: each.kind,
          shape: "whole",
          origin: "root-cause",
          document: `root-${each.document}`,
          sentence: each.text,
          parts: [each.text],
          probe: each.text,
          decoy: each.decoy,
        }));
        const cases = [
          ...earlier,
          ...added,
          ...beyondCases,
          ...lookCases,
          ...formCases,
          ...askCases,
          ...rootCases,
        ].filter(
          (each) =>
            (!ORIGINS || ORIGINS.includes(each.origin)) &&
            (!DOCUMENTS || DOCUMENTS.includes(each.document)),
        );
        for (const each of cases) {
          expect(each.parts.every((part) => each.sentence.includes(part))).toBe(true);
        }
        const libraries = [
          ...set.documents,
          ...(confirmed?.documents ?? []),
          ...(amended?.documents ?? []),
          ...(beyond?.documents ?? []).map((document) => ({
            ...document,
            key: `beyond-${document.key}`,
          })),
          ...(look?.documents ?? []).map((document) => ({
            ...document,
            key: `look-${document.key}`,
          })),
          ...(forms?.documents ?? []).map((document) => ({
            ...document,
            key: `forms-${document.key}`,
          })),
          ...(asks?.documents ?? []).map((document) => ({
            ...document,
            key: `asks-${document.key}`,
          })),
          ...(roots?.documents ?? []).map((document) => ({
            ...document,
            key: `root-${document.key}`,
          })),
        ].filter((document) => cases.some((each) => each.document === document.key));
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
        // The unit is the item: how many cases, how many read Supported in any check, and the
        // checks themselves; a check that settled nothing is counted apart, never as a refusal.
        const groups = new Map<
          string,
          {
            items: number;
            itemsSupported: number;
            checks: number;
            sorts: number;
            supported: number;
            unsettled: number;
          }
        >();
        for (const { case: each, samples } of results) {
          const name = `${each.decoy ? "decoy" : "positive"} ${each.shape} ${each.kind} (${each.origin})`;
          const row = groups.get(name) ?? {
            items: 0,
            itemsSupported: 0,
            checks: 0,
            sorts: 0,
            supported: 0,
            unsettled: 0,
          };
          row.items += 1;
          row.itemsSupported += samples.some(supported) ? 1 : 0;
          row.checks += samples.filter((sample) => !unsettled(sample)).length;
          row.sorts += new Set(
            samples.filter((sample) => !unsettled(sample)).map((sample) => sample.sort),
          ).size;
          row.supported += samples.filter(supported).length;
          row.unsettled += samples.filter(unsettled).length;
          groups.set(name, row);
        }
        const summary = {
          model: MODEL,
          language: set.language,
          runs: RUNS,
          groups: Object.fromEntries(groups),
          skipped: done.flatMap((each) => each.skipped),
          spent,
        };
        console.log(JSON.stringify(summary));
        report.push({ ...summary, results });
        if (REPORT) await writeFile(REPORT, JSON.stringify(report, null, 2));
        expect(results.every((each) => each.samples.length === RUNS)).toBe(true);
        expect(summary.skipped).toEqual([]);
      }
    },
  );
});
