/**
 * The sets a paired run asks from (README.md › Paired runs), and how one arm's run of one item is
 * read: from the User's action, the first sign of work, the first words and the end; the model
 * calls and tokens until the end; and the quality guards the set has.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { vi } from "vitest";
import type { ChatModelChoice, CoreEventName } from "../../src/core";
import { COMPARISON_CELL_NODE, DATABASE_FILE } from "../../src/core";
import { toolTextIn } from "../../src/core/answers/toolText";
import { openDatabase } from "../../src/core/storage";
import type { TimingOutcome } from "../../src/core/timing/timings";
import { comparisonCellOf } from "../../src/shared/comparisons";
import type { HelpLineKind } from "../../src/shared/helpReplyRead";
import { queryDatabase } from "../../tests/helpers/core";
import { connectToMind } from "../../tests/helpers/mindClient";
import { readMind } from "../../tests/helpers/minds";
import { type CaseResult, fetchPapers, fetchReserves, reports, runCase } from "../everyday/asking";
import { CASES, type LibraryName } from "../everyday/cases";
import { writeDatedDocuments } from "../everyday/dated";
import { judgeClaims } from "../everyday/judge";
import { asEvalQuestion } from "../hard/lib/citations";
import { fetchLibrary } from "../hard/lib/fetch";
import { loadManifest } from "../hard/lib/manifest";
import { loadHardQuestions, textProblems } from "../hard/lib/questions";
import { storedTextReader } from "../hard/lib/stored";
import { type AnswerRecord, askOne } from "../lib/citations";
import { type EvalQuestion, type ExpectedPassage, loadEvaluationSet } from "../lib/evaluationSet";
import { neededPassages } from "../lib/handed";
import { type Library, type LibraryOptions, openLibrary } from "../lib/library";
import { firstKeptText, isWrittenTwice, type TimingRecorder } from "../lib/timing";
import { SETS as CHECK_SETS, documentsOf, writeDocuments } from "../repeats/cases";
import { repeatChecks } from "../repeats/repeat";
import { verdictOf } from "../repeats/score";
import type { CheckReply } from "./arms";
import { SIGNS } from "./flows";
import type { Expectation, Grade } from "./judge";
import { citedText, type UnstatedSentence, unstatedSentences } from "./unstated";

export const SET_IDS = [
  "gating",
  "hard",
  "everyday",
  "checks",
  "cells",
  "written",
  "call-help",
  "call-help-held-out",
  "call-help-fresh",
  "call-help-documents",
  "call-help-checks",
  "call-help-marks",
  "call-help-marks-3",
  "call-help-marks-4",
  "meeting-notes",
] as const;
export type SetId = (typeof SET_IDS)[number];
export type Language = "en" | "zh-CN";

/** A model request or a step on this computer an item made, from the core's timing records. */
export interface RequestTiming {
  kind: "model" | "local";
  /** What it was for (src/core/timing): null for an Answer's own request. */
  step: string | null;
  model: string;
  reasoning: string | null;
  /** From the User's action. */
  startMs: number;
  /** From its own start. */
  firstByteMs: number | null;
  firstReasoningMs: number | null;
  firstTextMs: number | null;
  firstToolMs: number | null;
  endMs: number;
  inputTokens: number | null;
  outputTokens: number | null;
  /** "failed" when refused or failed, "stopped" when timed out or stopped; absent before 2026-11-12. */
  outcome?: TimingOutcome;
}

/** One place of a call-help reply, as the app showed it and the judge read it. */
export interface PlaceMark {
  id: string;
  number: number;
  marker: number;
  at: number;
  sentence: string;
  quotes: string[];
  /** Its quote was found, which alone gave a ✓ before #2847. */
  found: boolean;
  shown: boolean;
  unbacked: boolean | null;
}

/** What one arm did on one item. */
export interface ArmRun {
  status: "done" | "failed";
  error: string | null;
  firstSignMs: number | null;
  firstWordsMs: number | null;
  /** The first whole option, reading or line a help reply shows; absent: not a help reply. */
  firstOptionMs?: number | null;
  doneMs: number | null;
  modelCalls: number;
  /** Of them, the Answer's own: not its search rewrite, translation or checks. */
  answerCalls: number;
  /** The searches the Answer made, one made before the first call included; null: not counted. */
  searches: number | null;
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
  /**
   * A help reply as the model wrote it and as it was kept (#2847): its reader takes off what the
   * panel never draws, as a marker on a line to say, so a reading counts that from the text written.
   * `written`: the text the Answer engine streamed and kept; null when no recorder saw it. `stored`:
   * each line kept, with what its arm's form reads it as. `citations`: those it kept.
   */
  help?: {
    written: string | null;
    stored: { kind: HelpLineKind; text: string }[];
    citations: { marker: number; quote: string; check: string; passedAt: number[] }[];
  };
  /** Every Citation the reply's `cite` calls recorded, one its text no longer holds among them. */
  writtenCitations?: { marker: number; quote: string }[];
  /** Each request and local step, for an item that reads them (a help reply). */
  requests?: RequestTiming[];
  /**
   * Each place a Citation number sits in the reply (#2847's yardstick by place): its sentence, the
   * quotes that sentence cites, and the mark the app showed there; `unbacked` is the judge's answer
   * where it was asked per place, null where it wasn't.
   */
  places?: PlaceMark[];
  /**
   * Each reply of the sentence check while the item ran, as the check reads it: a reply that reads
   * fewer sentences than it was asked leaves them Not checked though its request finished.
   */
  checkReplies?: CheckReply[];
  /**
   * A help reply's marks (#2847), read once every mark settled. Of the Citations it shows whose
   * quote was found and whose sentence the judge says their quoted words hold (`held`): how many
   * show ✓, how many the check gave a verdict (passed it, or found it unsupported or
   * contradicted), and why each of the rest shows none, by its check and reason. Of those whose
   * quote was found and which the judge lists (`listed`): how many show ✓. And how long after the
   * reply's end the last mark settled. Absent: not a help reply, or one that didn't end.
   */
  marks?: {
    held: number;
    checked: number;
    judged: number;
    missed: Record<string, number>;
    listed: number;
    listedChecked: number;
    settledMs: number | null;
    /** The judge's own reply, as read: its grade and the numbers it listed. */
    judge: { grade: string; unstated: number[] };
    /** Each shown number: its Citation's check, its quote found, listed by the judge, and ✓ shown. */
    numbers: { number: number; check: string; found: boolean; listed: boolean; passed: boolean }[];
  };
}

/**
 * What an item measures itself; the times and calls come from the run around it, but for the
 * first sign and words of an item that tells them itself (`words: "item"`): a sign a window shows
 * that no Note's event carries, such as the meeting bar's.
 */
export type Measured = Omit<
  ArmRun,
  | "firstSignMs"
  | "firstWordsMs"
  | "doneMs"
  | "modelCalls"
  | "answerCalls"
  | "inputTokens"
  | "outputTokens"
> & { firstSignMs?: number | null; firstWordsMs?: number | null };

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
  /** For an item with no Answer whose end the core announces: its end, before what it reads afterwards (a grade). */
  ended?(): void;
  /** The recording Meeting its group heard, for an item asked during a call. */
  meeting?: { id: string };
}

export interface PairedItem {
  set: SetId;
  id: string;
  /** What a short run spreads over (INCARNAMIND_EVAL_SPEED_EACH): a difficulty, a group, a set. */
  kind: string;
  language: Language;
  /**
   * Where the first words are: the Answer's own text, the first words the core sends anywhere, or
   * those the item tells (the words a help panel shows).
   */
  words: "answer" | "events" | "item";
  run(context: ItemContext): Promise<Measured>;
}

export interface OpenedGroup {
  library: Library;
  /** Items it can't ask: a hard-tier Question whose quotes the stored text doesn't hold. */
  leftOut?: ReadonlySet<string>;
  /** The Meeting it recorded, for items asked during a call. */
  meeting?: { id: string };
  close(): Promise<void>;
}

/** Items, and the library they are asked in, opened only when one of them runs. */
export interface PairedGroup {
  name: string;
  items: readonly PairedItem[];
  open(base: GroupOptions): Promise<OpenedGroup>;
}

export type GroupOptions = Omit<LibraryOptions, "name" | "documents">;

/**
 * The group's library opened once for each arm, each a core on its own data folder: in one core,
 * the second arm found the first arm's Note of the same title and wrote into it.
 */
export async function openForArms(
  group: Pick<PairedGroup, "open">,
  options: (which: 0 | 1) => GroupOptions,
): Promise<[OpenedGroup, OpenedGroup]> {
  const first = await group.open(options(0));
  try {
    return [first, await group.open(options(1))];
  } catch (error) {
    await first.close().catch((closing: unknown) => {
      console.error(
        "The first arm's library didn't close after the second failed to open:",
        closing,
      );
    });
    throw error;
  }
}

const languageOf = (language: "en" | "zh" | "zh-CN"): Language =>
  language === "en" ? "en" : "zh-CN";

export const NOTHING: Measured = {
  status: "done",
  error: null,
  searches: null,
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
    async run({ library, grade, claimsJudge }) {
      return measuredAnswer(
        await askOne(library, question, 1, timeoutMs),
        {
          question: question.question,
          quotes: neededPassages(question).map((each) => each.quote),
          ...extra,
        },
        grade,
        claimsJudge,
      );
    },
  };
}

/** Each sentence the false-Supported judge listed, with the quotes it read, for reading by hand. */
const flaggedLines = (unstated: readonly UnstatedSentence[] | null) =>
  (unstated ?? []).map(
    ({ sentence, quotes }) =>
      `[unstated] ${sentence} ‖ ${quotes.map((quote) => `“${quote}”`).join(" · ")}`,
  );

/** What a Question's Answer is read for: its Citations, grade, false Supported and claimed changes. */
export async function measuredAnswer(
  answer: Pick<
    AnswerRecord,
    "status" | "error" | "searches" | "citations" | "expected" | "timing" | "text"
  >,
  expected: Expectation,
  grade: ItemContext["grade"],
  judge: ItemContext["claimsJudge"],
): Promise<Measured> {
  const done = answer.status === "done";
  const unstated = done
    ? await unstatedSentences(
        judge,
        answer.citations.map((citation, index) => ({
          // A result from before sentences were numbered keeps each Citation apart.
          at: citation.sentenceIndex ?? -(index + 1),
          sentence: citation.sentence,
          quote: citation.quote,
          found: citation.outcome === "found",
        })),
      )
    : [];
  // A Question asked in a Note is offered no Tool that changes one: any change it claims is unmade.
  const claimed = done ? (await judgeClaims(judge, answer.text, [])).unbacked : [];
  return {
    ...NOTHING,
    status: done ? "done" : "failed",
    error: done
      ? null
      : answer.error
        ? `${answer.error.kind}: ${answer.error.message}`
        : answer.status,
    searches: answer.searches.length,
    citations: answer.citations.length,
    found: answer.citations.filter((citation) => citation.outcome === "found").length,
    cited: done && answer.expected ? answer.expected.cited === answer.expected.needed : null,
    grade: done ? await grade(expected, answer.text) : null,
    falseSupported: unstated?.length ?? 0,
    duplicate: answer.timing?.writtenTwice ?? false,
    // A Tool's call written as text that still shows fails the Answer, whatever it is graded.
    failures: [
      ...(toolTextIn(answer.text).length > 0 ? ["tool-text"] : []),
      ...(unstated === null ? ["false-supported-unread"] : []),
      ...(claimed.length > 0 ? ["unbacked"] : []),
    ],
    // Each Citation not found, to tell a quote the model changed from one it put on the wrong page.
    text: [
      answer.text,
      ...flaggedLines(unstated),
      ...claimed.map((sentence) => `[unbacked] ${sentence}`),
      ...answer.citations
        .filter((citation) => citation.outcome !== "found")
        .map(
          (citation) =>
            `[${citation.outcome}] “${citation.quote}” (${citation.documentName}, p. ${citation.pageFrom ?? "?"}–${citation.pageTo ?? "?"}; on p. ${citation.quoteOn?.join("–") ?? "none"}; ${citation.checkReason ?? citation.check})`,
        ),
    ].join("\n"),
  };
}

/**
 * What a comparison table's filled cell is read for, over the Document `documentName`: cited when a
 * found Citation in it covers each needed Passage's pages, its grade, false Supported and duplicates.
 */
export async function measuredCell(
  filled: ProseMirrorNode,
  documentName: string,
  question: string,
  needed: readonly ExpectedPassage[],
  grade: ItemContext["grade"],
  judge: ItemContext["claimsJudge"],
): Promise<Measured> {
  const { status, problem } = comparisonCellOf(filled.attrs);
  const shown = citedText(filled);
  const found = shown.citations.filter((each) => each.check === "found");
  const text = filled.textBetween(0, filled.content.size, " ", " ").trim();
  const answered = status === "done" || problem === "not-found";
  // Each Citation on the line of the cell it sits in, as the judge reads it.
  const lines = shown.text.split("\n");
  const unstated = answered
    ? await unstatedSentences(
        judge,
        shown.citations.map((citation, index) => {
          const at = lines.findIndex((line) => line.includes(`[${index + 1}]`));
          return {
            at: at === -1 ? -(index + 1) : at,
            sentence: (lines[at] ?? "").replace(/\[\d+\]/g, "").trim(),
            quote: citation.quote ?? "",
            found: citation.check === "found",
          };
        }),
      )
    : [];
  return {
    ...NOTHING,
    status: answered ? "done" : "failed",
    error: answered ? null : `${status}: ${problem ?? ""}`,
    citations: shown.citations.length,
    found: found.length,
    cited: needed.every((expected) =>
      found.some(
        (each) =>
          each.documentName === documentName &&
          each.pageFrom != null &&
          each.pageTo != null &&
          each.pageFrom <= expected.pages[1] &&
          expected.pages[0] <= each.pageTo,
      ),
    ),
    grade: answered
      ? await grade({ question, quotes: needed.map((each) => each.quote) }, text)
      : null,
    falseSupported: unstated?.length ?? 0,
    duplicate: isWrittenTwice(text),
    failures: [
      ...(toolTextIn(text).length > 0 ? ["tool-text"] : []),
      ...(unstated === null ? ["false-supported-unread"] : []),
    ],
    text: [text, ...flaggedLines(unstated)].join("\n"),
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

/**
 * The gating set's Questions whose Passages are all in one Document, each asked as a comparison
 * table's one cell over that Document (#1631), as a Task asks it: cited when a found Citation in
 * the cell covers each Passage's pages in that Document.
 */
export function cellsSet(root: string, timeoutMs: number): PairedGroup[] {
  const set = loadEvaluationSet(root);
  const items = set.questions.flatMap((question): PairedItem[] => {
    const needed = neededPassages(question);
    const [key, ...others] = [...new Set(needed.map((each) => each.document))];
    if (key === undefined || others.length > 0) return [];
    return [
      {
        set: "cells",
        id: question.id,
        kind: groupOfQuestion(question),
        language: languageOf(question.language),
        words: "events",
        async run({ library, grade, arm, ended, claimsJudge }) {
          const document = library.documents.get(key);
          if (!document) throw new Error(`No Document ${key} in the library.`);
          const { core } = library;
          const mind = await core.createMind({ title: `${question.id} (${arm})` });
          const client = await connectToMind(core, mind.id);
          // A cell is an Answer no window hears of: its table's fill ending is its end.
          const fillEnded = new Promise<void>((resolve) => {
            const stop = core.on("comparison.filling", (event) => {
              if (event.mindId !== mind.id || event.filling) return;
              stop();
              resolve();
            });
          });
          library.timings?.begin();
          const started = await core.compareDocuments({
            mindId: mind.id,
            documentIds: [document.id],
            questions: [question.question],
          });
          if (!started.started)
            throw new Error(`The table wasn't made: ${JSON.stringify(started)}`);
          let timer: ReturnType<typeof setTimeout> | undefined;
          const late = new Promise<"late">((resolve) => {
            timer = setTimeout(() => resolve("late"), timeoutMs);
          });
          const end = await Promise.race([fillEnded, late]).finally(() => clearTimeout(timer));
          if (end === "late") {
            // Stopped, so its calls don't run on into the other arm's.
            await core.stopComparisonTable({ mindId: mind.id, tableId: started.tableId });
            throw new Error("The cell took too long.");
          }
          ended?.();
          await client.settled();
          let cell: ProseMirrorNode | null = null;
          readMind(client).descendants((node) => {
            if (node.type.name === COMPARISON_CELL_NODE) cell ??= node;
            return cell === null;
          });
          if (cell === null) throw new Error("The table has no cell.");
          const filled: ProseMirrorNode = cell;
          return measuredCell(filled, document.name, question.question, needed, grade, claimsJudge);
        },
      },
    ];
  });
  return [
    {
      name: "cells",
      items,
      async open(base) {
        const library = await openLibrary({
          ...base,
          name: "paired-cells",
          documents: set.documents,
        });
        return { library, close: () => library.close() };
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

/** What a Document states, all of it or for its own term, or what may read either way: Supported is right for these. */
const STATED = new Set(["supported", "partly", "not-contradicted"]);
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
              bar: "verdict",
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
    measured = await item.run({
      ...context,
      library: { ...context.library, timings },
      ended() {
        if (begun !== null) ended = performance.now() - begun;
      },
    });
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
    firstSignMs:
      item.words === "item" && measured.firstSignMs !== undefined ? measured.firstSignMs : sign,
    firstWordsMs:
      item.words === "item"
        ? (measured.firstWordsMs ?? null)
        : item.words === "answer"
          ? recording && firstKeptText(recording.textEvents)
          : words,
    doneMs,
    modelCalls: calls.length,
    inputTokens: calls.reduce((sum, call) => sum + (call.inputTokens ?? 0), 0),
    outputTokens: calls.reduce((sum, call) => sum + (call.outputTokens ?? 0), 0),
  };
}
