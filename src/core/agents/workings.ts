/**
 * Figures IncarnaMind works out for an outside agent (#3363), with the code its own check uses:
 * `calculate` over numbers the agent quotes from Passages (ADR-0021) and `run_analysis` over a whole
 * sheet or CSV file, or over the Library's lists (ADR-0023), each over what the agent may read and
 * nothing else. Each gets an id the agent names in `report_check`, where a verdict may rest on it
 * when it is that agent's and was made in that check.
 */

import { figureResultText } from "../../shared/figures";
import { formulaText } from "../../shared/formula";
import { LIBRARY_FACTS } from "../../shared/libraryFacts";
import type { AnalysisRuntime } from "../adapters";
import { analysisTool, writtenIn } from "../analysis/tool";
import {
  answerLanguage,
  createCalculationSession,
  FIX_FIGURES,
  givenList,
  MAX_FIGURES_PER_CALL,
} from "../answers/calculations";
import { libraryRead } from "../answers/checks/checkSetup";
import { endedAs, rowsOf, workingOf } from "../answers/checks/claimCheck";
import type { Worked } from "../answers/checks/judgedOutside";
import { type AnswerDocuments, createCitationSession } from "../answers/citations";
import type { AnswerAnalysis, CalculatedFigure, Citation } from "../api";
import type { CitationSource } from "../documents";
import type { WindowedPassage } from "../documents/search";
import { isLibraryList, type LibraryLists } from "../library/lists";
import { type AgentCitations, CITATION_TOKEN } from "./citations";

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
  /** The Library's lists of what it may read, with what they hold, read when a run first asks. */
  lists(): { lists: LibraryLists; read: AgentReach; version: string | null };
}

export interface AgentFigure {
  id: string;
  label: string;
  result: string;
  working: string;
}

export interface AgentCalculated {
  figures: AgentFigure[];
  /** What to fix, for the figures that weren't worked out; null when every one was. */
  problems: string | null;
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

  const documents = {
    citationSource: deps.citationSource,
    pageTexts: deps.pageTexts,
    documentDate: () => null,
    passage: deps.passage,
    ...(deps.passagesCovering && { passagesCovering: deps.passagesCovering }),
  };

  /** The figures worked out, and the Documents their inputs quote. */
  function calculate(given: unknown, to: WorkFor): Done<AgentCalculated> {
    const figures = givenList(given);
    if (figures.length === 0 || figures.length > MAX_FIGURES_PER_CALL) {
      return {
        result: { figures: [], problems: `Give 1 to ${MAX_FIGURES_PER_CALL} figures.` },
        documentIds: [],
      };
    }
    const problems: string[] = [];
    const shown = new Map<string, WindowedPassage>();
    // Each input placed on a Passage of the agent's: by the Citation it names, or by its passageId.
    const placed = figures.map((raw, at) => {
      const inputs = givenList(fields(raw).inputs).map((input) => {
        const read = fields(input);
        const name = words(read.name) || "input";
        const cite = words(read.cite);
        const token = [...cite.matchAll(CITATION_TOKEN)][0]?.[1] ?? cite;
        const kept = token === "" ? null : deps.citations.find(to.pairingId, token);
        const passageId = kept ? kept.passageId : words(read.passageId);
        const passage =
          kept && !to.documentIds.has(kept.documentId) ? null : ownPassage(to, passageId);
        if (!passage) {
          problems.push(
            cite !== ""
              ? `figure ${at + 1}, ${name}: ${cite} isn't a Citation of a Passage you can read now: cite its quote again`
              : `figure ${at + 1}, ${name}: give a cite, or a passageId and quote, from search or read_passages`,
          );
          return null;
        }
        shown.set(passage.passageId, passage);
        const { cite: _cite, passageId: _passageId, citation: _citation, ...rest } = read;
        return { ...rest, passageId: passage.passageId, quote: words(read.quote) || kept?.quote };
      });
      return inputs.every((input) => input !== null) ? { raw: fields(raw), inputs } : null;
    });
    const session = createCitationSession(documents, { onRecord: () => undefined });
    session.show([...shown.values()]);
    const handles = new Map(session.shownPassages().map((each) => [each.passageId, each.id]));
    const passages = new Map(session.shownPassages().map((each) => [each.id, each.passageId]));
    const asked = placed.flatMap((figure, at) =>
      figure
        ? [
            {
              ...figure.raw,
              marker: at + 1,
              inputs: figure.inputs.map(({ passageId, ...input }) => ({
                ...input,
                passage: handles.get(passageId) ?? "",
              })),
            },
          ]
        : [],
    );
    const calculator = createCalculationSession({
      documents: { pageTexts: deps.pageTexts },
      quotes: session.quotes,
      language: answerLanguage(figures.map((figure) => words(fields(figure).label)).join(" ")),
    });
    const told = asked.length > 0 ? calculator.calculate(asked) : "";
    calculator.check();
    if (told.includes(FIX_FIGURES)) {
      problems.push(
        ...told
          .split("\n")
          .filter((line) => line.startsWith("- "))
          .map((line) => line.slice(2)),
      );
    }
    const worked = asked.flatMap(({ marker }) => {
      const figure = calculator.figure(marker);
      return figure ? [{ marker, figure }] : [];
    });
    const mindId = checking(to.pairingId);
    const quoted = new Set<string>();
    const recorded = worked.flatMap(({ figure }) => {
      const evidence = figure.inputs.flatMap((input) => [
        input.citation,
        ...(input.unitStatement ? [input.unitStatement.citation] : []),
      ]);
      if (evidence.some((citation) => citation.check !== "found")) return [];
      const working = workedLine(figure);
      const documentIds = [...new Set(evidence.map((citation) => citation.documentId))];
      for (const each of documentIds) quoted.add(each);
      const id = keep("calc", {
        pairingId: to.pairingId,
        mindId,
        read: { documentIds, folderIds: [], mindIds: [] },
        worked: {
          ok: true,
          backing: {
            evidence,
            workedOut: working,
            versions: versionsOf(evidence),
            documentIds,
          },
        },
      });
      return [{ id, label: figure.label, result: figure.shown, working }];
    });
    // The calculation names Passages by the ids its own session gave them, and figures by marker.
    const inAgentWords = (line: string) =>
      line
        .replace(/\bP\d+\b/g, (handle) => passages.get(handle) ?? handle)
        .replace(/\[=(\d+)\]/g, "figure $1");
    return {
      result: {
        figures: recorded,
        problems: problems.length > 0 ? problems.map(inAgentWords).join("\n") : null,
      },
      documentIds: [...quoted],
    };
  }

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
    const title = words(given.title);
    const tool = analysisTool({
      runtime: analysisRuntime,
      passage(id) {
        const passage = ownPassage(to, id.trim());
        const source = passage ? deps.citationSource(passage.passageId) : null;
        return source && !source.documentDeleted
          ? {
              source,
              units: deps.pageTexts(source.documentId, source.contentHash, null, null),
            }
          : null;
      },
      number: () => ({
        problem:
          "run_analysis reads a file's rows and the lists only: work out a figure from numbers Passages give with calculate",
      }),
      figure: () => ++figures,
      language: answerLanguage(title),
      now: () => new Date(deps.now()),
      ran: (_call, run) => {
        got.run = run;
      },
      library(list) {
        got.lists ??= to.lists();
        return isLibraryList(list) ? got.lists.lists[list] : null;
      },
      readLibrary(_run, read) {
        got.listed = [...new Set(read)];
      },
    });
    const inputs = givenList(given.inputs).map((input) => {
      const { passageId, ...rest } = fields(input);
      return passageId === undefined ? rest : { ...rest, passage: passageId };
    });
    const report = await tool.call({ ...given, inputs }, { toolCallId: deps.newId(), signal });
    const { run, lists: read, listed } = got;
    if (!run) return { result: { id: null, report }, documentIds: [] };
    const rows = rowsOf(run);
    const documentIds = [...new Set(rows.map((each) => each.citation.documentId))];
    const id = keep("run", {
      pairingId: to.pairingId,
      mindId: checking(to.pairingId),
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
    calculate,
    analyse,
    confirmed,
    /** The Note a pairing is checking now: what it works out from here on is of that check. */
    checks(pairingId: string, mindId: string) {
      workings.checking.set(pairingId, mindId);
    },
  };
}

/** A calculated figure's working, its inputs as their quotes write them: "1,240,000 + 860,000 = £2,100,000". */
function workedLine(figure: CalculatedFigure): string {
  const byName = new Map(figure.inputs.map((input) => [input.name.toLowerCase(), input]));
  const worked = formulaText(
    figure.formula,
    (name) => byName.get(name.toLowerCase())?.number.chars ?? null,
  );
  return `${figure.label ? `${figure.label}: ` : ""}${worked} = ${figure.shown}`;
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
  const figures = run.output.results.flatMap((each) => (each.kind === "figure" ? [each] : []));
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
