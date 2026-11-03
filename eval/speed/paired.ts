/**
 * The sets a paired run asks from (README.md › Paired runs), and how one arm's run of one item is
 * read: from the User's action, the first sign of work, the first words and the end; the model
 * calls and tokens until the end; and the quality guards the set has.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vi } from "vitest";
import type { ChatModelChoice, CoreEventName } from "../../src/core";
import { DATABASE_FILE } from "../../src/core";
import { toolTextIn } from "../../src/core/answers/toolText";
import { openDatabase } from "../../src/core/storage";
import { queryDatabase } from "../../tests/helpers/core";
import { type CaseResult, fetchPapers, fetchReserves, reports, runCase } from "../everyday/asking";
import { CASES, type LibraryName } from "../everyday/cases";
import { writeDatedDocuments } from "../everyday/dated";
import { asEvalQuestion } from "../hard/lib/citations";
import { fetchLibrary } from "../hard/lib/fetch";
import { loadManifest } from "../hard/lib/manifest";
import { loadHardQuestions, textProblems } from "../hard/lib/questions";
import { storedTextReader } from "../hard/lib/stored";
import { askOne } from "../lib/citations";
import { type EvalQuestion, loadEvaluationSet } from "../lib/evaluationSet";
import { neededPassages } from "../lib/handed";
import { type Library, type LibraryOptions, openLibrary } from "../lib/library";
import { firstKeptText, isWrittenTwice, type TimingRecorder } from "../lib/timing";
import { SETS as CHECK_SETS, documentsOf, writeDocuments } from "../repeats/cases";
import { repeatChecks } from "../repeats/repeat";
import { verdictOf } from "../repeats/score";
import { SIGNS } from "./flows";
import type { Expectation, Grade } from "./judge";

export const SET_IDS = ["gating", "hard", "everyday", "checks"] as const;
export type SetId = (typeof SET_IDS)[number];
export type Language = "en" | "zh-CN";

/** What one arm did on one item. */
export interface ArmRun {
  status: "done" | "failed";
  error: string | null;
  firstSignMs: number | null;
  firstWordsMs: number | null;
  doneMs: number | null;
  modelCalls: number;
  /** Of them, the Answer's own: not its search rewrite, translation or checks. */
  answerCalls: number;
  inputTokens: number;
  outputTokens: number;
  citations: number;
  found: number;
  /** Every Passage the item needs is cited, with its quote found; null: it needs none. */
  cited: boolean | null;
  /** The judge's grade; null: the set has nothing to grade against. */
  grade: Grade | null;
  /** Sentences that came back Supported though the Documents don't state them. */
  falseSupported: number;
  /** The Answer says the same paragraph twice. */
  duplicate: boolean;
  /** The everyday guards it failed, by kind: "unbacked" is a change claimed that no Tool made. */
  failures: string[];
  /** The Answer or reply, to read a difference by hand. */
  text: string;
}

/** What an item measures itself; the times and calls come from the run around it. */
export type Measured = Omit<
  ArmRun,
  | "firstSignMs"
  | "firstWordsMs"
  | "doneMs"
  | "modelCalls"
  | "answerCalls"
  | "inputTokens"
  | "outputTokens"
>;

export interface ItemContext {
  /** The library, whose `timings.begin()` marks the User's action. */
  library: Library;
  choice: ChatModelChoice;
  /** Model name, as "<kind>/<model id>". */
  model: string;
  /** The arm, for the names of what an item makes. */
  arm: string;
  grade(expected: Expectation, answer: string): Promise<Grade>;
  claimsJudge: Parameters<typeof runCase>[2];
}

export interface PairedItem {
  set: SetId;
  id: string;
  /** What a short run spreads over (INCARNAMIND_EVAL_SPEED_EACH): a difficulty, a group, a set. */
  kind: string;
  language: Language;
  /** Where the first words are: the Answer's own text, or the first words the core sends anywhere. */
  words: "answer" | "events";
  run(context: ItemContext): Promise<Measured>;
}

export interface OpenedGroup {
  library: Library;
  /** Items it can't ask: a hard-tier Question whose quotes the stored text doesn't hold. */
  leftOut?: ReadonlySet<string>;
  close(): Promise<void>;
}

/** Items, and the library they are asked in, opened only when one of them runs. */
export interface PairedGroup {
  name: string;
  items: readonly PairedItem[];
  open(base: GroupOptions): Promise<OpenedGroup>;
}

export type GroupOptions = Omit<LibraryOptions, "name" | "documents">;

const languageOf = (language: "en" | "zh" | "zh-CN"): Language =>
  language === "en" ? "en" : "zh-CN";

const NOTHING: Measured = {
  status: "done",
  error: null,
  citations: 0,
  found: 0,
  cited: null,
  grade: null,
  falseSupported: 0,
  duplicate: false,
  failures: [],
  text: "",
};

function questionItem(
  set: SetId,
  question: EvalQuestion,
  kind: string,
  extra: Partial<Expectation>,
  timeoutMs: number,
): PairedItem {
  return {
    set,
    id: question.id,
    kind,
    language: languageOf(question.language),
    words: "answer",
    async run({ library, grade }) {
      const answer = await askOne(library, question, 1, timeoutMs);
      const done = answer.status === "done";
      return {
        ...NOTHING,
        status: done ? "done" : "failed",
        error: done
          ? null
          : answer.error
            ? `${answer.error.kind}: ${answer.error.message}`
            : answer.status,
        citations: answer.citations.length,
        found: answer.citations.filter((citation) => citation.outcome === "found").length,
        cited: done && answer.expected ? answer.expected.cited === answer.expected.needed : null,
        grade: done
          ? await grade(
              {
                question: question.question,
                quotes: neededPassages(question).map((each) => each.quote),
                ...extra,
              },
              answer.text,
            )
          : null,
        duplicate: answer.timing?.writtenTwice ?? false,
        // A Tool's call written as text that still shows fails the Answer, whatever it is graded.
        failures: toolTextIn(answer.text).length > 0 ? ["tool-text"] : [],
        text: answer.text,
      };
    },
  };
}

const groupOfQuestion = (question: EvalQuestion) =>
  question.crossLingual ? "cross-lingual" : question.paraphrase ? "paraphrase" : question.language;

export function gatingSet(root: string, timeoutMs: number): PairedGroup[] {
  const set = loadEvaluationSet(root);
  return [
    {
      name: "gating",
      items: set.questions.map((question) =>
        questionItem("gating", question, groupOfQuestion(question), {}, timeoutMs),
      ),
      async open(base) {
        const library = await openLibrary({
          ...base,
          name: "paired-gating",
          documents: set.documents,
        });
        return { library, close: () => library.close() };
      },
    },
  ];
}

export function hardSet(root: string, cacheDir: string, timeoutMs: number): PairedGroup[] {
  const manifest = loadManifest(root);
  const { questions } = loadHardQuestions(root, manifest);
  return [
    {
      name: "hard",
      items: questions.map((question) =>
        questionItem(
          "hard",
          asEvalQuestion(question),
          question.difficulty,
          {
            ...(question.answer && { answer: question.answer }),
            ...(question.premise && { premise: question.premise }),
          },
          timeoutMs,
        ),
      ),
      async open(base) {
        const fetched = await fetchLibrary(manifest, { root, cacheDir, log: base.log });
        const library = await openLibrary({
          ...base,
          name: "paired-hard",
          documents: fetched.documents.flatMap((document) =>
            document.status === "ready" && document.path
              ? [{ key: document.key, path: document.path }]
              : [],
          ),
          allowUnprocessed: true,
        });
        const ready = new Set(
          [...library.documents]
            .filter(([, document]) => document.status === "ready")
            .map(([key]) => key),
        );
        const ids = new Map([...library.documents].map(([key, document]) => [key, document.id]));
        const db = openDatabase(join(library.dataDir, DATABASE_FILE));
        const stored = storedTextReader(db, ids, ready);
        // As eval:hard leaves them out.
        const leftOut = new Set(
          questions
            .filter((question) => textProblems(question, stored, manifest).length > 0)
            .map((question) => question.id),
        );
        db.close();
        return { library, leftOut, close: () => library.close() };
      },
    },
  ];
}

const everydayKind = (each: (typeof CASES)[number]) =>
  each.research ? "research" : each.expected.write ? "write" : "question";

export function everydaySet(root: string, cacheDir: string): PairedGroup[] {
  const libraries: LibraryName[] = ["papers", "reports", "dated", "reserves"];
  return libraries.map((name) => ({
    name: `everyday-${name}`,
    items: CASES.filter((each) => each.library === name).map(
      (each): PairedItem => ({
        set: "everyday",
        id: each.id,
        kind: everydayKind(each),
        language: each.language,
        words: "events",
        async run({ library, claimsJudge, model }) {
          const scoped = [...library.documents.values()].map((document) => ({
            id: document.id,
            name: document.name,
          }));
          let result: CaseResult;
          try {
            result = await runCase(library, scoped, claimsJudge, model, each, {
              asking: () => library.timings?.begin(),
            });
          } finally {
            if (each.afterExample) {
              await library.core.updateSettings({ user: { language: "system" } });
            }
          }
          return {
            ...NOTHING,
            status: result.error ? "failed" : "done",
            error: result.error,
            duplicate: isWrittenTwice(result.reply),
            failures: result.failures.map((failure) => failure.kind),
            // What the claims judge read and flagged, to tell an unmade claim from the judge's error.
            text: [
              result.reply,
              ...result.calls.map((call) => `[call] ${call}`),
              ...result.failures.flatMap((failure) =>
                failure.kind === "unbacked"
                  ? failure.sentences.map((each) => `[unbacked] ${each}`)
                  : [],
              ),
            ].join("\n"),
          };
        },
      }),
    ),
    async open(base) {
      const dated = await mkdtemp(join(tmpdir(), "incarnamind-paired-dated-"));
      const documents =
        name === "papers"
          ? await fetchPapers(cacheDir, base.log)
          : name === "reports"
            ? await reports()
            : name === "dated"
              ? await writeDatedDocuments(dated)
              : await fetchReserves(cacheDir, base.log);
      const library = await openLibrary({
        ...base,
        name: `paired-${name}`,
        documents,
        examples: join(root, "resources", "examples"),
      });
      return {
        library,
        async close() {
          await library.close();
          await rm(dated, { recursive: true, force: true });
        },
      };
    },
  }));
}

/** What a Document states, all of it or for its own term: Supported is right for these. */
const STATED = new Set(["supported", "partly"]);
const FINISHED = new Set(["ready", "failed", "no-text"]);

export function checksSet(root: string): PairedGroup[] {
  const byLibrary = new Map<string, (typeof CHECK_SETS)[number][]>();
  for (const set of CHECK_SETS) {
    const key = [set.language, ...documentsOf(set).map((each) => each.file)].join("\n");
    byLibrary.set(key, [...(byLibrary.get(key) ?? []), set]);
  }
  return [...byLibrary.values()].map((sets) => {
    const [first] = sets as [(typeof CHECK_SETS)[number]];
    return {
      name: `checks-${sets.map((set) => set.id).join("+")}`,
      items: sets.map(
        (set): PairedItem => ({
          set: "checks",
          id: set.id,
          kind: set.id,
          language: set.language,
          words: "events",
          async run({ library, choice, arm }) {
            library.timings?.begin();
            const results = await repeatChecks(library.core, {
              mind: `${set.mind} (${arm})`,
              sentences: set.sentences.map((each) => each.text),
              repeats: 1,
              model: choice,
              onRepeat: () => true,
            });
            const wrong = results.filter((result) => {
              const sentence = set.sentences.find((each) => each.text === result.sentence);
              return (
                sentence !== undefined &&
                sentence.knownMiss === undefined &&
                !STATED.has(sentence.expected) &&
                verdictOf(result.outcome) === "supported"
              );
            });
            return {
              ...NOTHING,
              falseSupported: wrong.length,
              failures: results.flatMap((result) =>
                result.outcome === "not-checked" ? ["not-checked"] : [],
              ),
              text: results.map((result) => `${result.outcome}: ${result.sentence}`).join("\n"),
            };
          },
        }),
      ),
      async open(base) {
        const folder = await mkdtemp(join(tmpdir(), "incarnamind-paired-checks-"));
        const library = await openLibrary({
          ...base,
          name: "paired-checks",
          documents: await writeDocuments(folder, first),
          examples: join(root, "resources", "examples"),
        });
        const { core } = library;
        // A first run's Library, as eval:repeats has it: the example's Documents beside the set's.
        await core.updateSettings({ user: { language: first.language } });
        await core.createExamples();
        await vi.waitFor(
          async () => {
            const all = await core.listDocuments();
            if (
              all.length <= library.documents.size ||
              all.some((each) => !FINISHED.has(each.status))
            )
              throw new Error("The example's Documents are still being read.");
          },
          { timeout: 10 * 60_000, interval: 1000 },
        );
        return {
          library,
          async close() {
            await library.close();
            await rm(folder, { recursive: true, force: true });
          },
        };
      },
    };
  });
}

const WORDS: ReadonlySet<CoreEventName> = new Set(["answer.delta", "mind.update"]);
const ENDS: readonly CoreEventName[] = ["answer.finished", "answer.failed"];

/**
 * Runs an item on one arm, reading its times from the User's action, which the item marks with
 * the library's `timings.begin()`: the first sign the core sends, the first words (the Answer's
 * own text that stayed, or the first words sent anywhere), and the end of the last Answer (or
 * of the item, for one with no Answer), with the model calls made by then.
 */
export async function runOnArm(
  item: PairedItem,
  context: Omit<ItemContext, "library"> & { library: Library; recorder: TimingRecorder },
): Promise<ArmRun> {
  const { core } = context.library;
  let begun: number | null = null;
  let begunAt = "";
  let sign: number | null = null;
  let words: number | null = null;
  let ended: number | null = null;
  const stops = [
    ...SIGNS.map((event) =>
      core.on(event, () => {
        if (begun === null) return;
        sign ??= performance.now() - begun;
        if (WORDS.has(event)) words ??= performance.now() - begun;
      }),
    ),
    ...ENDS.map((event) =>
      core.on(event, () => {
        if (begun !== null) ended = performance.now() - begun;
      }),
    ),
  ];
  const timings: TimingRecorder = {
    ...context.recorder,
    begin() {
      begun = performance.now();
      begunAt = new Date().toISOString();
      sign = words = ended = null;
      context.recorder.begin();
    },
  };
  let measured: Measured;
  try {
    measured = await item.run({ ...context, library: { ...context.library, timings } });
  } catch (error) {
    measured = {
      ...NOTHING,
      status: "failed",
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    for (const stop of stops) stop();
  }
  const finished = begun === null ? null : performance.now() - begun;
  const doneMs = ended ?? finished;
  const recording = begun === null ? null : context.recorder.end();
  const calls = (recording?.modelCalls ?? []).filter(
    (call) => doneMs === null || call.startMs <= doneMs,
  );
  // The core tags a call made for an Answer by its step (src/core/timing): untagged, it is the Answer's.
  const own =
    begun === null
      ? []
      : queryDatabase<{ started_at: string }>(
          context.library.dataDir,
          "SELECT started_at FROM ai_timings WHERE kind = 'model' AND step IS NULL AND started_at >= ?",
          [begunAt],
        ).filter(
          (row) => doneMs === null || Date.parse(row.started_at) <= Date.parse(begunAt) + doneMs,
        );
  return {
    ...measured,
    answerCalls: own.length,
    firstSignMs: sign,
    firstWordsMs:
      item.words === "answer" ? recording && firstKeptText(recording.textEvents) : words,
    doneMs,
    modelCalls: calls.length,
    inputTokens: calls.reduce((sum, call) => sum + (call.inputTokens ?? 0), 0),
    outputTokens: calls.reduce((sum, call) => sum + (call.outputTokens ?? 0), 0),
  };
}
