/**
 * A check's Run: the Answer engine's Tool-calling loop (ADR-0007) with the check Tool set (ADR-0013),
 * the turn checks that ask again for a reply the check can read, and what the verdicts are read
 * from once it ends.
 */
import type { CheckFigure, CitationSupport, ProviderError } from "../../api";
import type { EvidenceScope } from "../../documents/evidence";
import type { Language } from "../../language";
import { givesStructuredOutput } from "../../providers/capabilities";
import type { PreparedChatModel } from "../../providers/chat";
import type { CalculationSession } from "../calculations";
import type { createCitationSession } from "../citations";
import { type AnswerTools, documentToolDefinitions } from "../engine";
import type { TurnCheck, TurnFinding } from "../turnChecks";
import { type CalculationLedger, calculatesIn } from "./calculationLedger";
import type { CheckResults } from "./checkResults";
import { asPassage, checkSession, citedSources, NO_DATE } from "./checkSetup";
import type { ClaimCheckDependencies, ClaimCheckRequest } from "./claimCheck";
import {
  analysisItemDisagrees,
  givesItsOwnNumber,
  readFigureReply,
  readFigureSource,
} from "./figureChecks";
import {
  checkInstructions,
  claimPrompt,
  deniesItself,
  heldDetailLines,
  namesNothing,
  ownDetailDiffers,
  ownDetailUnread,
  ownWords,
  type ReadVerdict,
  readVerdict,
  replyAcrossTurns,
  sentenceItIsPartOf,
} from "./prompt";
import { searchAgain } from "./searchAgain";

const SEARCH_FIRST =
  "You gave a verdict without searching the User's Documents. Search them with search_documents first, then give your verdict from what you find.";

const FIGURES_LINE =
  "Your reply has no Figures line that can be read. Write your whole reply again, ending with the one Figures: line, its JSON object on that line.";

const REMAINDER_LINE =
  'Your Figures line gives no remainder. Give "remainder": null when the sentence asserts nothing beyond its figures, or its other assertion as the instructions say, then write your whole reply again.';

const analysisNamesNote = (problems: readonly string[]) =>
  [
    "Your Figures line disagrees with itself for an Analysis's figure:",
    ...problems,
    'For each, give "names":"same" with verdict supported, relation equals, topic found, roles same and scope same only when the sentence names the figure as its label and rule say; "names":"other" with verdict unsupported when it names another figure; otherwise "names":"unclear" with verdict unsupported. Then write your whole reply again.',
  ].join("\n");

const figureSourcesNote = (problems: readonly string[], unrecorded: readonly number[]) =>
  [
    ...(unrecorded.length > 0
      ? [
          `Your Figures line names ${unrecorded.map((marker) => `[^${marker}]`).join(", ")}, never recorded: call cite now with each quote it uses, under the marker you gave it.`,
        ]
      : []),
    ...(problems.length > 0
      ? ["Some sources in your Figures line can't be read:", ...problems.map((each) => `- ${each}`)]
      : []),
    "Fix each one, then write your whole reply again, its Figures line included.",
  ].join("\n");

/**
 * A verdict whose requested figures aren't bound is asked for once more, as `calculate` answers
 * an input it can't read: Claude Haiku 5.5 wrote its verdict and stopped, skipped the cite
 * call, or left out the heading that states a sheet's unit, for about a third of sentences
 * with figures. A figure the model calls contradicted or unsupported is asked about only when
 * its source gives the very number it contradicts; with a source that can't be read it is
 * Unsupported, since asked to cite a number its quote doesn't hold, Claude Haiku 5.5 often wrote
 * prose in place of its reply (#2184). A remainder is asked for only when the reply's own verdict
 * is Supported: a stricter one stands for the sentence's other words (`withSentenceVerdict`).
 * `asking` is told each reply asked about, read across its turns by `across`, which keeps the
 * Duty and Condition lines held back across an earlier ask (#1766).
 */
function figuresReplied(
  request: Pick<ClaimCheckRequest, "claim" | "figures">,
  calculations: Pick<CalculationSession, "number" | "figure">,
  searched: () => boolean,
  recorded: (marker: number) => boolean,
  asking: (text: string) => void,
  across: (last: string, setAside?: readonly string[]) => string,
): TurnCheck[] {
  const figures = request.figures ?? [];
  const asked = (text: string) => figures.length > 0 && searched() && readVerdict(text) !== null;
  const ask = (text: string, finding: TurnFinding): TurnFinding => {
    asking(text);
    return finding;
  };
  return [
    {
      name: "figures-line",
      check(last, setAside = []) {
        const text = across(last, setAside);
        if (!asked(text)) return null;
        const read = readFigureReply(text, figures, request.claim);
        if (!read) return ask(text, { claims: [], note: FIGURES_LINE });
        // Without its remainder a Supported reply can't be settled, so it is asked for as the line is.
        return read.remainder === undefined && readVerdict(text)?.verdict === "supported"
          ? ask(text, { claims: [], note: REMAINDER_LINE })
          : null;
      },
    },
    {
      // The judge decides an Analysis figure: a reply whose fields disagree is asked once (#2378).
      name: "analysis-names",
      check(last, setAside = []) {
        const text = across(last, setAside);
        const read = asked(text) ? readFigureReply(text, figures, request.claim) : null;
        if (!read) return null;
        const problems = read.items.flatMap((item) => {
          const target = figures.find((figure) => figure.id === item.id);
          // One the request gave no evidence for, behind a wall, has nothing to name.
          const disagrees =
            target?.calculated?.figure.analysis && target.analysisRecord?.label !== undefined
              ? analysisItemDisagrees(item)
              : null;
          return target && disagrees ? [`${target.reading.chars}: ${disagrees}.`] : [];
        });
        return problems.length > 0
          ? ask(text, { claims: [], note: analysisNamesNote(problems) })
          : null;
      },
    },
    {
      name: "figures-sources",
      check(last, setAside = []) {
        const text = across(last, setAside);
        const read = asked(text) ? readFigureReply(text, figures, request.claim) : null;
        if (!read) return null;
        // A supported figure with no source must record its quote, not only write it in prose:
        // told to give its source, Claude Haiku 5.5 wrote a marker and no cite, and the check ended
        // no-evidence with a quote the reader could see.
        let needsCite = false;
        const problems = read.items.flatMap((item) => {
          const target = figures.find((figure) => figure.id === item.id);
          if (!target) return [];
          if (item.verdict !== "supported") {
            const judged = item.topic === "found" && item.scope === "same" && item.roles === "same";
            const source =
              judged && item.verdict === "contradicted" && item.source
                ? readFigureSource(calculations, target, item.source)
                : null;
            if (source && "input" in source && givesItsOwnNumber(target, source.input))
              return [
                `${target.reading.chars}: you call it contradicted, but its source gives the same number, ${source.input.number.chars}; give as source the number the Document gives for its own subject, period, column and unit, or the verdict that number gives.`,
              ];
            // Claude Haiku 5.5 left a case it could read undecided: it gave neither the number the
            // Document states nor what differs, so its verdict rests on nothing a reader can see.
            // An Analysis's figure and a saved calculation have no source in a Document by design.
            return !target.calculated &&
              target.analysisRecord == null &&
              item.source === null &&
              item.calculation === null &&
              item.says === null
              ? [
                  `${target.reading.chars}: you give neither the Document's number nor what differs; give as source the number the Document gives for its own subject, period, column and unit, with the reading its context takes where its readings offer one, or the verdict that number gives.`,
                ]
              : [];
          }
          if (!item.source && item.calculation !== null && !calculations.figure(item.calculation))
            return [
              `${target.reading.chars}: calculation [=${item.calculation}] wasn't worked out in this check; call calculate for it, or give its source.`,
            ];
          if (!item.source) {
            if (item.calculation !== null || target.calculated) return [];
            needsCite = true;
            return [
              `${target.reading.chars}: a supported figure needs its source (a quote recorded with cite, and the number as it writes it) or its calculation.`,
            ];
          }
          const source = readFigureSource(calculations, target, item.source);
          return "problem" in source ? [`${target.reading.chars}: ${source.problem}`] : [];
        });
        const remainder = read.remainder?.citation;
        if (remainder && !recorded(remainder))
          problems.push(`remainder: [^${remainder}] isn't recorded; record it with cite first.`);
        const unrecorded = [
          ...new Set(
            [
              ...read.items.flatMap((item) =>
                item.verdict === "supported" && item.source?.citation ? [item.source.citation] : [],
              ),
              ...(remainder ? [remainder] : []),
            ].filter((marker) => !recorded(marker)),
          ),
        ];
        return problems.length > 0 || unrecorded.length > 0
          ? ask(text, {
              claims: [],
              note: figureSourcesNote(problems, unrecorded),
              ...((unrecorded.length > 0 || needsCite) && { requires: "cite" }),
            })
          : null;
      },
    },
  ];
}

/** What a check Run starts from: its sentence, read in its paragraph, beside what it cites. */
export type CheckStart = Pick<
  ClaimCheckRequest,
  "claim" | "originalClaim" | "context" | "cited" | "figures"
> & {
  /** Its first turn names the sentence's parts (`ClaimCheckRequest.findParts`). */
  findsParts?: boolean;
  /** It may show the Library's facts (`ClaimCheckRequest.searched`), so it sorts as their checks do. */
  library?: boolean;
};

/** A check Run's instructions, for the way its model gives Citations, and its prompt. */
function runStart(request: CheckStart, language: Language, calculating: boolean) {
  return {
    instructions: (mode: CitationSupport | "no-documents", passages?: string) =>
      checkInstructions(
        mode,
        language,
        passages,
        calculating,
        (request.figures?.length ?? 0) > 0,
        request.findsParts === true,
        request.library === true,
        request.claim,
        sentenceItIsPartOf(request.claim, request.originalClaim) !== null,
      ),
    prompt: (citedShown: string | null) => claimPrompt({ ...request, citedShown, language }),
  };
}

/**
 * What every request of a check Run sends before the Passages its search returns: its
 * instructions, its prompt and its Tools' definitions, as the Run builds them. A model that can't
 * call Tools is sent the Passages in its instructions, and no Tools.
 */
export function checkRunStart(
  deps: Pick<ClaimCheckDependencies, "documents" | "language">,
  request: CheckStart & { scope: EvidenceScope },
  model: Pick<PreparedChatModel, "support" | "capabilities">,
): { instructions: string; prompt: string; tools: string } {
  const calculating = calculatesIn(model, request);
  const start = runStart(request, deps.language(), calculating);
  const cited = citedSources(request.cited ?? [], request.scope, deps.documents);
  const { documents } = deps;
  const session = checkSession({
    citationSource: (passageId) => documents.citationSource(passageId),
    pageTexts: (documentId, contentHash, from, to) =>
      documents.pageTexts(documentId, contentHash, from, to),
    documentDate: NO_DATE,
  });
  const mode = model.support ?? "tools";
  const tools: AnswerTools = {
    documentCount: 1,
    documentLanguages: deps.documents.searchableLanguages(request.scope.documentIds),
    ...(deps.documents.getMany && { fileProperties: true }),
    searchDocuments: async () => ({ text: "", passageCount: 0 }),
    cite: () => "",
    ...(calculating && { calculate: () => "" }),
  };
  return {
    instructions: start.instructions(mode),
    prompt: start.prompt(cited.length > 0 ? session.measure(cited.map(asPassage)) : null),
    tools: mode === "tools" ? documentToolDefinitions(tools, "check") : "",
  };
}

/**
 * A Supported reply whose Roles line gives other words than the sentence's as its own compared
 * something else: Claude Haiku 5.5 wrote the Passage's direction ("向人力资源总监汇报" for
 * "人力资源总监向乙方汇报"), "none" for "should be carried over", then called the two the same
 * (#1766). It can't be read as support.
 */
const ROLES_OWN_WORDS =
  "Your Roles line's first side isn't the sentence's own words. Copy from the sentence, word for word and in its own order, the words that say who does it, for or to whom, and whether it must or may happen, or, when it names no one, the words for what happens; then \" / \" and the Passage's words; then same, differs or other. Then give your whole reply again.";

/**
 * How a Supported reply whose Duty or Condition line is missing or can't be read is asked for it
 * again. It names the Duty line's words: a line with the same duty in two words ("has to / must,
 * same") can't be read, and the form's word on each side can (#1766).
 */
const DETAIL_FORM =
  "your whole reply again in the form asked for: its Duty line gives each side as one of must, should, may, must not or none, and its Condition line each side's condition as written, or none; each line ends with same or differs.";

const DETAIL_LINES = `Your reply has no Duty or Condition line that can be read. Write ${DETAIL_FORM}`;

/** A reply whose own Duty or Condition sides deny its "same" is told so: the ask names what is wrong. */
const DETAIL_DENIED = `Your reply's Duty or Condition line says same while its two sides differ: two different duties, or a condition on one side and none on the other. Compare the two sides again and write ${DETAIL_FORM}`;

/**
 * `asked`: a reply of this check has already given other words than the sentence's. A Roles line
 * naming nothing on either side is held back only where the reply's own Scope line names the
 * sentence's party or term: a figure's or a cell's sentence often names neither ("Scope: none,
 * same" for 杠杆率仍应在3.25倍的契约上限之内), but one that names the Tenant has its words to copy.
 */
export function comparesOtherWords(verdict: ReadVerdict, claim: string, asked: boolean): boolean {
  if (verdict.verdict !== "supported") return false;
  const sides = verdict.rolesSides;
  if (sides === undefined) return asked;
  if (namesNothing(sides)) return asked || verdict.scopeNames === true;
  return !ownWords(sides[0] ?? "", claim);
}

/** What the verdicts are read from once the Run has ended. */
export interface RunTranscript {
  reply: string;
  /** That reply read across its turns, with the Duty and Condition lines held back across an ask. */
  written(): string;
  /** The reply an ask about its Figures line was about. */
  askedAbout: string | null;
  /** A reply compared other words than the sentence's (`comparesOtherWords`). */
  askedForOwnWords: boolean;
  failed: ProviderError | null;
  finished: boolean;
}

export async function checkRun(
  deps: Pick<
    ClaimCheckDependencies,
    "engine" | "language" | "walledDocument" | "fileProperties" | "libraryFacts"
  >,
  request: Pick<
    ClaimCheckRequest,
    | "claim"
    | "context"
    | "cited"
    | "figures"
    | "findParts"
    | "window"
    | "thirdParty"
    | "cacheKey"
    | "model"
    | "scope"
    | "signal"
  >,
  run: {
    tools: AnswerTools;
    session: ReturnType<typeof createCitationSession>;
    citedShown: string | null;
    looked(): boolean;
    searches(): number;
    readsWhole(): boolean;
    calculating: boolean;
    ledger: Pick<CalculationLedger, "calculations" | "attempts" | "requiresCalculation">;
    results: Pick<CheckResults, "readInWindow">;
  },
): Promise<RunTranscript> {
  const { scope, signal, model } = request;
  const { tools, session, citedShown, looked, readsWhole, calculating, ledger, results } = run;
  let reply = "";
  let heard = "";
  let parted = false;
  const hear = (text: string) => {
    if (parted || !request.findParts) return;
    parted = true;
    request.findParts(text);
  };
  let setAside: readonly string[] = [];
  // The Duty and Condition lines that took support away before an ask about something else: the
  // engine sets aside no turn across an ask, and a difference the check wrote down holds (#1766).
  // An ask for those very lines drops them, as the reply written again answers it.
  let heldBack: readonly string[] = [];
  const across = (last: string, aside: readonly string[] = []) =>
    replyAcrossTurns(last, heldBack.length > 0 ? [heldBack.join("\n"), ...aside] : aside);
  // Set by any reply that compared other words than the sentence's, whether or not the ask was
  // still free: a later reply that gives none is held back as one that gives other words.
  let askedForOwnWords = false;
  let askedAbout: string | null = null;
  let failed: ProviderError | null = null;
  let finished = false;
  // A run that read a Document a wall keeps from this check backs nothing here, and what it read
  // never goes to the model: its label, rows and code stay out of the request (#2378).
  const walledRun = (figure: CheckFigure) =>
    (figure.analysisRecord?.citations ?? []).some(
      ({ documentId }) =>
        deps.walledDocument(documentId) !== null &&
        (scope.documentIds === null ||
          !scope.documentIds.includes(documentId) ||
          scope.excluded.has(documentId)),
    );
  const asked: typeof request = {
    ...request,
    ...(request.figures && {
      figures: request.figures.map((figure) =>
        figure.analysisRecord && walledRun(figure)
          ? {
              ...figure,
              analysisRecord: {
                recalculated: figure.analysisRecord.recalculated,
                citations: figure.analysisRecord.citations,
              },
            }
          : figure,
      ),
    }),
  };
  const start = runStart(
    {
      ...asked,
      findsParts: request.findParts !== undefined,
      library: deps.libraryFacts !== undefined,
    },
    deps.language(),
    calculating,
  );
  for await (const event of deps.engine.generate({
    instructions: (mode, options) => start.instructions(mode, options?.passages),
    messages: [{ role: "user", content: start.prompt(citedShown) }],
    question: request.claim,
    model: model.model,
    documents: tools,
    ...(request.window && {
      fitted: (passageIds: readonly string[]) => {
        const fitted = new Set(passageIds);
        for (const passage of request.window ?? []) {
          if (fitted.has(passage.passageId)) results.readInWindow(passage);
        }
      },
    }),
    tools: [],
    toolSet: "check",
    thirdParty: request.thirdParty ?? [],
    support: model.support,
    structuredOutput: givesStructuredOutput(model.capabilities),
    takesTemperature: model.capabilities.facts.temperature,
    ...(model.provider.kind === "openrouter" && {
      forcedToolChoice: model.capabilities.facts.forcedToolChoice,
    }),
    window: model.window,
    ...(model.capabilities.facts.maxOutput !== undefined && {
      maxOutput: model.capabilities.facts.maxOutput,
    }),
    retryQuotes: model.retryQuotes,
    cacheKey: request.cacheKey,
    isReply: (text) => readVerdict(text) !== null,
    ...(request.findParts && { afterFirstStep: hear }),
    // A model may give its verdict before it has looked: Claude Haiku 5.5 did, about one check
    // in six of a whole Mind.
    turnChecks: [
      {
        name: "search-first",
        check: (text) =>
          !looked() && readVerdict(text) ? { claims: [], note: SEARCH_FIRST } : null,
      },
      // In a window of a whole read every search returns that window: the read is the search.
      ...(request.window ? [] : [searchAgain(run.searches, readsWhole)]),
      ...(deps.fileProperties ? [deps.fileProperties.turnCheck] : []),
      ...(deps.libraryFacts
        ? [deps.libraryFacts.turnCheck(() => session.tools.recordedQuotes?.() ?? [])]
        : []),
      ...figuresReplied(
        asked,
        ledger.calculations,
        looked,
        (marker) => session.tools.hasRecord?.(marker) ?? false,
        (text) => {
          askedAbout = text;
        },
        across,
      ),
      {
        name: "calculate-first",
        // A sentence checked figure by figure gives each figure's calculation on its Figures
        // line (`figuresReplied`), never a Calculation line.
        check: async (text) =>
          !request.figures?.length &&
          ledger.attempts() === 0 &&
          (await ledger.requiresCalculation(readVerdict(text)))
            ? {
                claims: [],
                note: "The numerical check is incomplete. If the Documents let you work out the claim's quantity or comparison, call calculate with the cited inputs, formula and stated quantity before giving a verdict. Never calculate in your head. If a Document states the claim directly, record its deciding quote and write Calculation: none. Otherwise name each required quantity on a Calculation: line; if its inputs cannot be found, say that it could not be calculated.",
              }
            : null,
      },
      {
        name: "roles-own-words",
        check: (text, aside) => {
          const read = across(text, aside);
          const verdict = readVerdict(read);
          if (!verdict || !comparesOtherWords(verdict, request.claim, false)) return null;
          askedForOwnWords = true;
          return { claims: [], writeOnly: true, note: ROLES_OWN_WORDS };
        },
      },
      {
        name: "own-detail",
        check: (text, aside) => {
          const read = across(text, aside);
          const verdict = readVerdict(read);
          // One line that already differs takes the support away: no ask can give it back.
          if (
            verdict?.verdict !== "supported" ||
            ownDetailDiffers(verdict) ||
            !ownDetailUnread(verdict)
          )
            return null;
          return {
            claims: [],
            writeOnly: true,
            note: deniesItself(read) ? DETAIL_DENIED : DETAIL_LINES,
          };
        },
      },
    ],
    onAsk: (note, last, aside) => {
      heldBack =
        note === DETAIL_LINES || note === DETAIL_DENIED ? [] : heldDetailLines(across(last, aside));
    },
    signal,
  })) {
    if (event.type === "text-delta") {
      reply += event.text;
      heard += event.text;
    } else if (event.type === "text-retracted") reply = reply.slice(0, -event.length);
    else if (event.type === "text-set-aside") setAside = event.texts;
    else if (event.type === "failed") failed = event.error;
    else if (event.type === "finished") finished = true;
  }
  if (!failed) hear(heard);
  deps.fileProperties?.replied(across(reply, setAside));
  deps.libraryFacts?.replied(across(reply, setAside));
  return {
    reply,
    written: () => across(reply, setAside),
    askedAbout,
    askedForOwnWords,
    failed,
    finished,
  };
}
