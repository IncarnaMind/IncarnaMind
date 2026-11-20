/**
 * Figures IncarnaMind works out or confirms for an outside agent: `run_analysis` over a whole sheet
 * or CSV file, or over the Library's lists (ADR-0023), over what the agent may read and nothing
 * else, which gets an id the agent names in `report_check`; and the working an agent gives
 * `report_check` for a figure it worked out itself from numbers Passages give (#3393), whose
 * numbers are confirmed in their quotes and whose expression is worked out again.
 */
import { figureResultText } from "../../shared/figures";
import { LIBRARY_FACTS } from "../../shared/libraryFacts";
import { workPlain } from "../../shared/plainFigures";
import type { AnalysisRuntime } from "../adapters";
import { analysisTool, writtenIn } from "../analysis/tool";
import { answerLanguage, givenList } from "../answers/calculations";
import { libraryRead } from "../answers/checks/checkSetup";
import { endedAs, rowsOf, workingOf } from "../answers/checks/claimCheck";
import type { Worked } from "../answers/checks/judgedOutside";
import type { AnswerDocuments } from "../answers/citations";
import type { AnswerAnalysis, Citation } from "../api";
import type { CitationSource } from "../documents";
import type { WindowedPassage } from "../documents/search";
import { isLibraryList, type LibraryLists } from "../library/lists";
import type { AgentCitations } from "./citations";

/** What a pairing may read now, as a run over the Library's lists reads it. */
export interface AgentReach {
  documentIds: readonly string[];
  folderIds: readonly string[];
  mindIds: readonly string[];
}

interface AgentWorking {
  pairingId: string;
  /** The Note this pairing was checking when it was made; null for none. */
  mindId: string | null;
  read: AgentReach;
  worked: Worked;
}

/** What IncarnaMind worked out for agents, by id, and the Note each pairing is checking. */
export interface AgentWorkings {
  made: Map<string, AgentWorking>;
  checking: Map<string, string>;
}

export const createAgentWorkings = (): AgentWorkings => ({ made: new Map(), checking: new Map() });

/** The most kept, of every pairing: the oldest go first. */
const KEPT = 500;

export interface WorkOutDeps {
  /** Runs `run_analysis`'s code; absent where this computer can't run Python for IncarnaMind. */
  analysisRuntime?: AnalysisRuntime;
  passage(passageId: string): WindowedPassage | null;
  passagesBetween(documentId: string, from: number, to: number): WindowedPassage[];
  citationSource(passageId: string): CitationSource | null;
  pageTexts: AnswerDocuments["pageTexts"];
  passagesCovering?: AnswerDocuments["passagesCovering"];
  citations: Pick<AgentCitations, "find">;
  workings: AgentWorkings;
  newId(): string;
  now(): string;
}

/** Who a figure is worked out for, and what it may read. */
export interface WorkFor {
  pairingId: string;
  documentIds: ReadonlySet<string>;
  /**
   * The Library's lists of what it may read, with what they hold, read when a run first asks;
   * `checking` is the Note the pairing was checking when the run began.
   */
  lists(checking: string | null): { lists: LibraryLists; read: AgentReach; version: string | null };
}

interface Done<T> {
  result: T;
  documentIds: string[];
}

export interface AgentAnalysed {
  /** Null when nothing ran. */
  id: string | null;
  report: string;
}

/** What `run_analysis` says of an input that names no file the agent can read, whatever it named. */
const NO_FILE =
  "give a documentId or a passageId of a sheet or CSV file you can read, from search, read_passages or list_minds";

export const pythonRuns = (runtime: AnalysisRuntime | undefined): runtime is AnalysisRuntime =>
  runtime?.languages.some((each) => each.language === "python") === true;

const fields = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const words = (value: unknown): string => (typeof value === "string" ? value.trim() : "");

const versionsOf = (citations: readonly Citation[]) => [
  ...new Map(
    citations.map(({ documentId, contentHash }) => [
      `${documentId}\u0000${contentHash}`,
      { documentId, contentHash },
    ]),
  ).values(),
];

export function createWorkOut(deps: WorkOutDeps) {
  const { workings } = deps;

  const keep = (prefix: string, working: AgentWorking): string => {
    const id = `${prefix}-${deps.newId().replace(/-/g, "").slice(0, 10)}`;
    workings.made.set(id, working);
    for (const old of workings.made.keys()) {
      if (workings.made.size <= KEPT) break;
      workings.made.delete(old);
    }
    return id;
  };

  const checking = (pairingId: string) => workings.checking.get(pairingId) ?? null;

  /** A live Passage of the agent's, or null: an unknown one and one outside its reach alike. */
  const ownPassage = (to: WorkFor, passageId: string): WindowedPassage | null => {
    const passage = passageId === "" ? null : deps.passage(passageId);
    return passage && to.documentIds.has(passage.documentId) ? passage : null;
  };

  /** What the run gave the agent, and the Documents whose rows it read. */
  async function analyse(
    given: Record<string, unknown>,
    to: WorkFor,
    signal: AbortSignal,
  ): Promise<Done<AgentAnalysed>> {
    const { analysisRuntime } = deps;
    if (!pythonRuns(analysisRuntime)) throw new Error("No Python runtime.");
    const got: {
      run: AnswerAnalysis | null;
      lists: ReturnType<WorkFor["lists"]> | null;
      listed: string[];
    } = { run: null, lists: null, listed: [] };
    let figures = 0;
    // The check the run is of is the one going when it began: one begun meanwhile can't rest on it.
    const mindId = checking(to.pairingId);
    const title = words(given.title);
    const tool = analysisTool({
      runtime: analysisRuntime,
      passage(id) {
        // A file is named by its Document's id as often as by a Passage of it, in either field.
        const named = id.trim();
        const passage =
          ownPassage(to, named) ??
          (to.documentIds.has(named) ? (deps.passagesBetween(named, 0, 0)[0] ?? null) : null);
        const source = passage ? deps.citationSource(passage.passageId) : null;
        return source && !source.documentDeleted
          ? {
              source,
              units: deps.pageTexts(source.documentId, source.contentHash, null, null),
            }
          : { problem: NO_FILE };
      },
      number: () => ({
        problem:
          "run_analysis reads a file's rows and the lists only: a figure from numbers Passages give is your own working",
      }),
      figure: () => ++figures,
      language: answerLanguage(title),
      now: () => new Date(deps.now()),
      ran: (_call, run) => {
        got.run = run;
      },
      library(list) {
        got.lists ??= to.lists(mindId);
        return isLibraryList(list) ? got.lists.lists[list] : null;
      },
      readLibrary(_run, read) {
        got.listed = [...new Set(read)];
      },
    });
    const inputs = givenList(given.inputs).map((input) => {
      const { passageId, documentId, ...rest } = fields(input);
      const file = documentId ?? passageId;
      return file === undefined ? rest : { ...rest, passage: file };
    });
    const report = await tool.call({ ...given, inputs }, { toolCallId: deps.newId(), signal });
    const { run, lists: read, listed } = got;
    if (!run) return { result: { id: null, report }, documentIds: [] };
    const rows = rowsOf(run);
    const documentIds = [...new Set(rows.map((each) => each.citation.documentId))];
    const id = keep("run", {
      pairingId: to.pairingId,
      mindId,
      read: {
        documentIds: [...new Set([...documentIds, ...(read?.read.documentIds ?? [])])],
        folderIds: read?.read.folderIds ?? [],
        mindIds: read?.read.mindIds ?? [],
      },
      worked: workedRun(run, read && listed.some(isLibraryList) ? { ...read, listed } : null),
    });
    return { result: { id, report: `Run ${id}\n${report}` }, documentIds };
  }

  /**
   * A calculation or run this pairing had made while it checked `mindId`, as a verdict rests on it;
   * null when it is no such thing, or read what the pairing may no longer.
   */
  function confirmed(
    id: string,
    pairingId: string,
    mindId: string,
    reach: {
      documentIds: ReadonlySet<string>;
      folderIds: ReadonlySet<string>;
      mindIds: ReadonlySet<string>;
    },
  ): Worked | null {
    const working = workings.made.get(id.trim());
    if (!working || working.pairingId !== pairingId || working.mindId !== mindId) return null;
    const { read } = working;
    const within =
      read.documentIds.every((each) => reach.documentIds.has(each)) &&
      read.folderIds.every((each) => reach.folderIds.has(each)) &&
      read.mindIds.every((each) => reach.mindIds.has(each));
    return within ? working.worked : null;
  }

  return {
    analyse,
    confirmed,
    /** The Note a pairing is checking now: what it works out from here on is of that check. */
    checks(pairingId: string, mindId: string) {
      workings.checking.set(pairingId, mindId);
    },
  };
}

/**
 * What a verdict resting on a run keeps, as the check's own keeps it (./claimCheck): the rows it
 * read and its code, or the Library's lists it counted, and the figures it gave; or why it backs
 * none. A run that read the lists is told only numbers, so a figure is named only as its code
 * writes the name.
 */
function workedRun(
  run: AnswerAnalysis,
  lists: { lists: LibraryLists; version: string | null; listed: string[] } | null,
): Worked {
  const rows = rowsOf(run);
  const file = rows[0]?.citation.documentName ?? run.title;
  if (run.end.kind !== "done") return { ok: false, reason: endedAs(run), detail: file };
  if (rows.some((each) => each.cut)) return { ok: false, reason: "rows-cut", detail: file };
  // A figure IncarnaMind worked out again from the cells and found different has no marker: the
  // run's report says it can't be used, and no verdict rests on it.
  const usable = new Set(run.markers.figures.map((each) => each.result));
  const figures = run.output.results.flatMap((each) =>
    each.kind === "figure" && usable.has(each.name) ? [each] : [],
  );
  if (figures.length === 0) return { ok: false, reason: "no-evidence", detail: null };
  const library = lists ? libraryRead(lists.lists, lists.listed.filter(isLibraryList)) : null;
  // A mark is compared with the lists as the Note's own check counts them, which the window knows.
  const version = lists?.version ?? library?.citation.contentHash ?? null;
  const counted =
    library && version !== null
      ? { ...library.citation, passageId: version, contentHash: version }
      : null;
  const evidence = [...rows.map((each) => each.citation), ...(counted ? [counted] : [])];
  return {
    ok: true,
    backing: {
      evidence,
      working: { ...workingOf(run), ...(library && { library: library.read }) },
      workedOut: figures
        .map((each, at) => {
          const name = !lists
            ? each.label || each.name
            : writtenIn(run.code, each.name)
              ? each.name
              : `result ${at + 1}`;
          return `${name} = ${figureResultText("en", each.value, each.label)}${each.unit ? ` ${each.unit}` : ""}`;
        })
        .join("; "),
      versions: [
        ...versionsOf(rows.map((each) => each.citation)),
        ...(counted ? [{ documentId: LIBRARY_FACTS, contentHash: counted.contentHash }] : []),
      ],
      documentIds: [...new Set(rows.map((each) => each.citation.documentId))],
    },
  };
}

/**
 * A figure an agent worked out itself, as it gives it to `report_check` (#3393): each input's
 * number with the Citation whose quote holds it, the expression over their names and the figure
 * it gives. IncarnaMind confirms by digits that each number stands in its quote and that the
 * expression gives the figure, which reads no unit: the backing of a worked-out verdict; or what
 * doesn't hold, in words for the agent.
 */
export function workedFrom(
  given: unknown,
  citationOf: (cite: string) => Citation | null,
): { ok: true; worked: Worked } | { ok: false; problem: string } {
  const working = fields(given);
  const expression = words(working.expression);
  const figure = words(working.figure);
  const inputs = givenList(working.inputs).map(fields);
  if (inputs.length === 0 || expression === "" || figure === "")
    return {
      ok: false,
      problem:
        "give working its inputs (name, value and cite of each), its expression and the figure it gives",
    };
  const problems: string[] = [];
  const cited = inputs.flatMap((input) => {
    const name = words(input.name) || "input";
    const value =
      typeof input.value === "number"
        ? input.value
        : words(input.value)
          ? Number(input.value)
          : NaN;
    const citation = citationOf(words(input.cite));
    if (!Number.isFinite(value)) {
      problems.push(`${name}: give its value as a plain number`);
      return [];
    }
    if (!citation) {
      problems.push(`${name}: give the [cite:…] of a quote you can read now that holds its number`);
      return [];
    }
    return [{ name, value, citation }];
  });
  if (problems.length > 0) return { ok: false, problem: problems.join("; ") };
  const worked = workPlain({
    inputs: cited.map(({ name, value, citation }) => ({ name, value, quote: citation.quote })),
    formula: expression,
    shown: figure,
  });
  if ("problems" in worked) return { ok: false, problem: worked.problems.join("; ") };
  const evidence = cited.map((each) => each.citation);
  return {
    ok: true,
    worked: {
      ok: true,
      backing: {
        evidence,
        workedOut: worked.working,
        versions: versionsOf(evidence),
        documentIds: [...new Set(evidence.map((each) => each.documentId))],
      },
    },
  };
}
