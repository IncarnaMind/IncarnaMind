/**
 * A sentence's first reply (#2532): once its parts are known, the app searches the sentence's own
 * words and one request answers every part from the Passages it hands over (`handOrder`), each in
 * the reply form of a check's Run, the records of all of them in the same reply. A part's reply is
 * read as its Run's would be after that same search: it settles the part unless a turn check would
 * send the Run back for more (to search again, to give its own words, a calculation or its Duty
 * and Condition), it can't be read, or it leaves the part not checked. Such a part, and only it,
 * goes on to its own Run, whose search of the same words is the one made here. A part with figures
 * gives its Figures line as its Run would, and settles only when each of its figures is Supported or
 * Contradicted from a quote: nothing is worked out in one reply, so a figure its Run might
 * calculate goes on to that Run.
 */
import { caseCitations } from "../../../shared/caseCitations";
import type { ClaimPartPlan } from "../../api";
import type { WindowedPassage } from "../../documents/search";
import { isRecord } from "../../errors";
import { LANGUAGE_NAMES } from "../../language";
import type { PromptTag } from "../../promptData";
import { recordCiteSpans } from "../../recordCites/parser";
import { inStep } from "../../timing/flows";
import { answerTemperature, type CitationRecordInput, parseRecords } from "../engine";
import { type JudgePart, json, judge } from "../judge";
import { createCheckResults } from "./checkResults";
import { checkTurnChecks, figuresSent, type RunTranscript } from "./checkRun";
import { setUpRun } from "./checkSetup";
import {
  type AtomicClaimCheckResult,
  type ClaimCheckDependencies,
  type ClaimCheckRequest,
  handsOff,
  prepareCheck,
  shownResult,
  verdictOfReply,
} from "./claimCheck";
import { readFigureReply } from "./figureChecks";
import {
  CHECK_TAGS,
  figuresData,
  firstReplyInstructions,
  type ReadVerdict,
  readCheckReply,
  replyAcrossTurns,
} from "./prompt";

/** A part to answer in the first reply: where it is among the sentence's parts, and its request. */
export interface FirstPart {
  index: number;
  plan: ClaimPartPlan;
  request: ClaimCheckRequest;
}

/** What the first reply came to for a part: its result, or why it goes on to its Run. */
export type FirstReplied = { settled: AtomicClaimCheckResult } | { goesOn: string };

const FIRST_REPLY_TAGS: readonly PromptTag[] = [...CHECK_TAGS, "part"];

/** Whether a sentence's parts are answered first in one reply: each a fact, and nothing cited. */
export function repliesFirst(
  deps: Pick<ClaimCheckDependencies, "checkPaths">,
  request: ClaimCheckRequest,
  parts: readonly FirstPart[],
): boolean {
  const sentence = request.originalClaim ?? request.claim;
  return (
    parts.length > 0 &&
    parts.every((part) => part.plan.kind === "fact") &&
    request.only === undefined &&
    request.figureIds === undefined &&
    !request.undecidedOnly &&
    caseCitations(sentence).length === 0 &&
    recordCiteSpans(request.recordClaim ?? sentence).length === 0 &&
    handsOff(deps, request)
  );
}

/** The reply: each part's reply by its number, and the records of all of them. */
export const FIRST_REPLY = json(
  (value): { replies: Map<number, string>; records: CitationRecordInput[] } | null => {
    if (!isRecord(value) || !Array.isArray(value.parts)) return null;
    const replies = new Map<number, string>();
    for (const each of value.parts) {
      if (isRecord(each) && typeof each.part === "number" && typeof each.reply === "string")
        replies.set(each.part, each.reply);
    }
    return replies.size === 0 ? null : { replies, records: parseRecords(value.citations) };
  },
);

/** The markers a part's reply names: on its Evidence and Coverage lines, and in its words. */
function markersOf(reply: string, verdict: ReadVerdict): Set<number> {
  return new Set([
    ...(verdict.evidence ?? []),
    ...(verdict.coverage?.members.flatMap((member) => member.evidence) ?? []),
    ...(verdict.coverage?.domainEvidence ?? []),
    ...[...reply.matchAll(/\[\^(\d{1,4})\]/g)].map((match) => Number(match[1])),
  ]);
}

/** A part's figures as its Run sends them (`figuresSent`). */
const sentFigures = (deps: ClaimCheckDependencies, part: FirstPart) =>
  figuresSent(deps, part.request.scope, part.request.figures ?? []);

function firstReplyParts(
  deps: ClaimCheckDependencies,
  request: ClaimCheckRequest,
  passages: string,
  parts: readonly FirstPart[],
  language: Parameters<typeof firstReplyInstructions>[0],
): JudgePart[] {
  const claim = request.originalClaim ?? request.claim;
  const context = request.context?.trim();
  const withFigures = parts.some((part) => (part.request.figures?.length ?? 0) > 0);
  return [
    ...(context && context !== claim.trim()
      ? [
          "The paragraph it is in, for what its words refer to:",
          { tag: "paragraph" as const, text: context },
          "",
        ]
      : []),
    "Passages found in the User's Documents for this sentence:",
    passages,
    "",
    "The sentence to check:",
    { tag: "sentence", text: claim.trim() },
    "",
    withFigures
      ? "Its parts, each checked on its own words, each with the exact occurrences requested of it; their ids and locations distinguish repeated equal values. For each one with analysis, judge only whether the sentence names it, and give its names:"
      : "Its parts, each checked on its own words:",
    ...parts.flatMap((part, at): JudgePart[] => {
      const figures = sentFigures(deps, part);
      return [
        {
          tag: "part",
          attributes: { number: String(at + 1) },
          text: part.request.claim,
          inline: true,
        },
        ...(figures.length > 0
          ? [
              {
                tag: "figures" as const,
                attributes: { part: String(at + 1) },
                text: figuresData(figures),
              },
            ]
          : []),
      ];
    }),
    "",
    `Write each part's Explanation in ${LANGUAGE_NAMES[language]}.`,
  ];
}

/** A part's reply, read as its Run's last reply would be. */
async function settle(
  deps: ClaimCheckDependencies,
  part: FirstPart,
  reply: string,
  records: readonly CitationRecordInput[],
  handed: readonly WindowedPassage[],
  sentence: string,
): Promise<FirstReplied> {
  const { request } = part;
  const prepared = await prepareCheck(deps, request);
  if (!prepared) return { goesOn: "stopped" };
  const { setup, ledger, readsWhole } = prepared;
  setup.handOver(sentence, handed);
  const verdict = readCheckReply(reply);
  if (!verdict) return { goesOn: "unread" };
  if (verdict.evidence === undefined) return { goesOn: "no-evidence-line" };
  const named = markersOf(reply, verdict);
  const own = records.filter((record) => named.has(record.marker));
  if (own.length > 0) setup.session.tools.cite(own, { structured: true });
  const sent = sentFigures(deps, part);
  const turns = checkTurnChecks(
    deps,
    { ...request, ...(sent.length > 0 && { figures: sent }) },
    {
      looked: setup.looked,
      searches: setup.searches,
      readsWhole,
      session: setup.session,
      ledger,
      across: (last, aside = []) => replyAcrossTurns(last, aside),
      askedAbout: () => undefined,
      askedForOwnWords: () => undefined,
    },
  );
  for (const turn of turns) if (await turn.check(reply, [])) return { goesOn: turn.name };
  if (sent.length > 0) {
    const read = readFigureReply(reply, sent, request.claim);
    if (!read) return { goesOn: "figures-line" };
    if (read.items.some((item) => item.verdict !== "supported" && item.verdict !== "contradicted"))
      return { goesOn: "figure-not-settled" };
  }
  const transcript: RunTranscript = {
    reply,
    written: () => reply,
    askedAbout: null,
    askedForOwnWords: false,
    failed: null,
    finished: true,
  };
  const result = await shownResult(
    deps,
    request,
    () => verdictOfReply(deps, request, prepared, transcript),
    setup.shownPassageIds,
  );
  return result.verdict === "not-checked"
    ? { goesOn: `not-checked: ${result.reason}` }
    : { settled: result };
}

/**
 * Each part's first reply, by its index; null when nothing was asked: the search found nothing,
 * or the check was stopped. `request.ahead` is the sentence's own search (`ownSearch`), which a
 * part's Run of the same words takes as its own.
 */
export async function firstReply(
  deps: ClaimCheckDependencies,
  request: ClaimCheckRequest,
  parts: readonly FirstPart[],
): Promise<Map<number, FirstReplied> | null> {
  const { signal, model } = request;
  const sentence = request.originalClaim ?? request.claim;
  const searching = setUpRun(deps, request, createCheckResults(request));
  let handed: WindowedPassage[];
  try {
    handed = await searching.ownPassages(signal);
  } catch (error) {
    if (signal.aborted) return null;
    throw error;
  }
  const heard = (outcome: string) => {
    for (const part of parts)
      deps.checkPaths?.firstReplied?.({ sentence, part: part.request.claim, outcome });
  };
  if (handed.length === 0) {
    heard("nothing-found");
    return null;
  }
  const language = deps.language();
  const passages = searching.session.show(handed);
  const judged = await inStep("first-reply", () =>
    judge({
      model: model.model,
      question: {
        id: "first-reply",
        instructions: firstReplyInstructions(
          language,
          sentence,
          parts.some((part) => (part.request.figures?.length ?? 0) > 0),
        ),
      },
      parts: firstReplyParts(deps, request, passages, parts, language),
      data: FIRST_REPLY_TAGS,
      reply: FIRST_REPLY,
      items: parts.length,
      retries: 1,
      signal,
      temperature: answerTemperature(model.capabilities.facts.temperature),
    }),
  );
  if (signal.aborted) return null;
  if (!judged.ok) {
    if (judged.reason === "failed" || judged.reason === "cut-short")
      console.warn(
        `A sentence's first reply failed, so its parts go on to their checks: ${judged.error?.message ?? judged.reason}`,
      );
    heard(`reply-${judged.reason}`);
    return new Map(parts.map((part) => [part.index, { goesOn: `reply-${judged.reason}` }]));
  }
  const { replies, records } = judged.value;
  const replied = await Promise.all(
    parts.map(async (part, at): Promise<[number, FirstReplied]> => {
      const reply = replies.get(at + 1);
      const outcome: FirstReplied = reply
        ? await settle(deps, part, reply, records, handed, request.claim)
        : { goesOn: "not-answered" };
      deps.checkPaths?.firstReplied?.({
        sentence,
        part: part.request.claim,
        outcome: "settled" in outcome ? outcome.settled.verdict : outcome.goesOn,
      });
      return [part.index, outcome];
    }),
  );
  return new Map(replied);
}
