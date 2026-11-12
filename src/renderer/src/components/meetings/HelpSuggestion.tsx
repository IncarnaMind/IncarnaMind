import { useEffect, useState } from "react";
import type {
  ConversationAnswer,
  MarkedCitation,
  MeetingHelp,
  MeetingHelpKind,
} from "../../../../core/api";
import { citedLocation } from "../../../../shared/citations";
import { isTranscriptLocation } from "../../../../shared/locations";
import { HELP_SHAPE, helpLabel } from "../../../../shared/meetingHelp";
import { isTheirs, SPEAKER_ME } from "../../../../shared/speakers";
import { useAnswers } from "../../answers";
import { core } from "../../core";
import {
  callStarts,
  citationNumbers,
  helpParts,
  quoted,
  type ReplyItem,
  type ReplyPiece,
  sentencePassed,
  startedLabel,
  uncheckedReason,
} from "../../helpReply";
import { useLanguage, useT } from "../../i18n";
import { useJudgementLimit } from "../../judgementLimit";
import { isLive, useMeetings } from "../../meetings";
import { useModelNames, useServiceName } from "../../modelNames";
import { answerProblem } from "../../problems";
import { CheckLineIcon, DocumentLineIcon } from "../lineIcons";

/** A help Answer, as the core writes it: loaded once, then each write as it streams. */
export function useHelpAnswer(
  help: { conversationId: string; answerId: string } | null,
): ConversationAnswer | null {
  const [answer, setAnswer] = useState<ConversationAnswer | null>(null);
  const conversationId = help?.conversationId;
  const answerId = help?.answerId;
  useEffect(() => {
    setAnswer(null);
    if (!conversationId || !answerId) return;
    let live = true;
    const stop = core.on("conversation.message", (message) => {
      if (live && message.kind === "answer" && message.id === answerId) setAnswer(message);
    });
    core.getConversation(conversationId).then(
      ({ messages }) => {
        const found = messages.find((message) => message.id === answerId);
        if (found?.kind === "answer") setAnswer((now) => now ?? found);
      },
      // Deleted meanwhile: the panel shows no suggestion.
      () => undefined,
    );
    return () => {
      live = false;
      stop();
    };
  }, [conversationId, answerId]);
  return answer;
}

/**
 * A Citation's number, with ✓ only where the sentence check passed the sentence it is cited in at
 * `at` (#2847): a found quote alone earns none. The ✓ keeps its place whether it shows or not, so
 * nothing moves when it comes after the reply.
 */
function CitationChip({
  citation,
  number,
  at,
  started,
}: {
  citation?: MarkedCitation;
  number: number;
  at: number;
  /** When its call started, where the sources show it (`callStarts`). */
  started: string | null;
}) {
  const t = useT();
  const limits = useJudgementLimit();
  const where = citation ? citedLocation(citation, t) : null;
  const passed = citation !== undefined && sentencePassed(citation, at);
  const reason = citation ? uncheckedReason(citation) : null;
  const unchecked =
    reason === "answer-limit"
      ? t("citation.reason.answer-limit", { limit: limits.limit })
      : reason === "monthly-limit"
        ? t("citation.reason.monthly-limit", { cap: limits.cap })
        : reason === "small-model"
          ? t("citation.reason.small-model")
          : null;
  return (
    <span
      data-testid="help-citation"
      data-check={citation?.check ?? "checking"}
      data-marker={citation?.marker}
      data-passed={passed}
      data-at={at}
      title={
        citation
          ? [[citation.documentName, where, started].filter(Boolean).join(", "), unchecked]
              .filter(Boolean)
              .join("\n")
          : undefined
      }
      className="help-citation"
    >
      {number}
      <CheckLineIcon
        aria-hidden="true"
        data-testid="help-citation-check"
        className="help-citation-found"
      />
    </span>
  );
}

function Pieces({
  pieces,
  answer,
  numbers,
  starts,
}: {
  pieces: readonly ReplyPiece[];
  answer: ConversationAnswer;
  numbers: ReadonlyMap<number, number>;
  starts: ReadonlyMap<string, string>;
}) {
  return (
    <>
      {pieces.map((piece, index) => {
        const key = `${piece.kind}-${index}`;
        if (piece.kind === "text") return <span key={key}>{piece.text}</span>;
        if (piece.kind === "figure") {
          const figure = answer.figures.find((each) => each.marker === piece.marker);
          return <span key={key}>{figure?.shown ?? ""}</span>;
        }
        const citation = answer.citations.find((each) => each.marker === piece.marker);
        const number = numbers.get(piece.marker);
        // A marker with no Citation is left out, as the assistant shows an Answer.
        if (number === undefined) return null;
        return (
          <CitationChip
            key={key}
            citation={citation}
            number={number}
            at={piece.at}
            started={(citation && starts.get(citation.documentId)) ?? null}
          />
        );
      })}
    </>
  );
}

function Item({
  item,
  answer,
  numbers,
  starts,
  said,
}: {
  item: ReplyItem;
  answer: ConversationAnswer;
  numbers: ReadonlyMap<number, number>;
  starts: ReadonlyMap<string, string>;
  /** It is an option to say: its sentence shows in quotation marks. */
  said: boolean;
}) {
  const t = useT();
  return (
    <div
      data-testid="help-option"
      data-recommended={item.recommended}
      className={`help-option${item.recommended ? " help-option--recommended" : ""}`}
    >
      <span className="help-option-mark">
        {item.recommended && (
          <span role="img" aria-label={t("meetings.help.recommended")}>
            ★
          </span>
        )}
      </span>
      <span data-testid="help-option-say" className="help-option-say">
        <Pieces
          pieces={said ? quoted(item.lead) : item.lead}
          answer={answer}
          numbers={numbers}
          starts={starts}
        />
      </span>
      {item.notes.map((note, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: a reading's notes are in the order written.
        <span key={index} data-testid="help-option-note" className="help-option-note">
          <Pieces pieces={note} answer={answer} numbers={numbers} starts={starts} />
        </span>
      ))}
      {item.effect && (
        <span data-testid="help-option-effect" className="help-option-effect">
          → <Pieces pieces={item.effect} answer={answer} numbers={numbers} starts={starts} />
        </span>
      )}
    </div>
  );
}

/** The outline of options still to come: shown within 100 ms of a press. */
export function HelpOutline({ count }: { count: number }) {
  return (
    <>
      {Array.from({ length: count }, (_, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: placeholders, all alike.
        <div key={index} data-testid="help-outline" aria-hidden="true" className="help-option">
          <span className="help-option-mark" />
          <span className="help-outline-lines">
            <span className="help-outline-line" style={{ width: "88%" }} />
            <span className="help-outline-line" style={{ width: "52%" }} />
          </span>
        </div>
      ))}
    </>
  );
}

/**
 * The heading over a suggestion: the button, then the line it answers ("They said: …"), or for
 * "What do they want?" that it is read from what they said.
 */
export function HelpHeading({
  kind,
  heard = null,
}: {
  kind: MeetingHelpKind;
  heard?: MeetingHelp["heard"];
}) {
  const t = useT();
  const said = heard
    ? t(
        isTheirs(heard.speaker)
          ? "meetings.help.theySaid"
          : heard.speaker === SPEAKER_ME
            ? "meetings.help.youSaid"
            : "meetings.help.said",
        { text: heard.text },
      )
    : null;
  const after = kind === "want" ? t("meetings.help.readFrom") : said;
  return (
    <p data-testid="help-heading" className="help-heading">
      <b>{t(helpLabel(kind))}</b>
      {after && (
        <span title={after} className="help-heading-after">
          {" · "}
          {after}
        </span>
      )}
    </p>
  );
}

/** The Citations the sources list, each with the number it shows. */
const citedIn = (answer: ConversationAnswer, numbers: ReadonlyMap<number, number>) =>
  [...numbers].flatMap(([marker, number]) => {
    const citation = answer.citations.find((each) => each.marker === marker);
    return citation ? [{ citation, number }] : [];
  });

function Sources({
  answer,
  numbers,
  starts,
}: {
  answer: ConversationAnswer;
  numbers: ReadonlyMap<number, number>;
  starts: ReadonlyMap<string, string>;
}) {
  const t = useT();
  const cited = citedIn(answer, numbers);
  if (cited.length === 0) return null;
  return (
    <ul data-testid="help-sources" className="help-sources">
      {cited.map(({ citation, number }) => {
        const where = citedLocation(citation, t);
        return (
          <li key={citation.marker} data-testid="help-source" className="help-source">
            <DocumentLineIcon
              kind={isTranscriptLocation(citation.location) ? "transcript" : "text"}
              className="size-[13px] shrink-0"
            />
            <span className="truncate">
              {[String(number), citation.documentName, where, starts.get(citation.documentId)]
                .filter(Boolean)
                .join(" · ")}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

/** Why a press gave no help, with Try again. */
function NoHelp({
  testId,
  message,
  onRetry,
}: {
  testId: string;
  message: string;
  onRetry(): void;
}) {
  const t = useT();
  return (
    <p role="alert" data-testid={testId} className="help-failed">
      {t("meetings.help.failed", { message })}
      <span aria-hidden="true"> · </span>
      <button type="button" onClick={onRetry} className="panel-link">
        {t("meetings.help.retry")}
      </button>
    </p>
  );
}

/**
 * A help button's Answer, laid out to be read in a second or two: the options with the
 * recommended first and starred, each with what it leads to; the Citations they rest on.
 * While it streams, the options still to come keep their outline.
 */
export function HelpSuggestion({
  help,
  answer,
  onRetry,
}: {
  help: Pick<MeetingHelp, "kind" | "heard">;
  answer: ConversationAnswer;
  onRetry(): void;
}) {
  const t = useT();
  const language = useLanguage();
  const meetings = useMeetings((state) => state.meetings);
  const providerId = answer.model?.providerId ?? null;
  const service = useServiceName(providerId);
  const shownModel = useModelNames()(answer.model?.modelId ?? "", providerId);
  const provider = useAnswers(
    (state) => state.models?.find((group) => group.provider.id === providerId)?.provider,
  );
  const failed = answer.status === "failed";
  // The panel is its own window: nothing else has loaded the providers that name the service.
  useEffect(() => {
    if (failed) useAnswers.getState().loadModels();
  }, [failed]);
  const why = answer.errorKind
    ? t(
        answerProblem(answer.errorKind, provider?.kind, undefined, {
          ...(provider && { local: provider.service === null }),
        }).line,
        {
          service,
          model: answer.model ? shownModel.name : t("answer.error.thisModel"),
        },
      )
    : (answer.errorMessage ?? "");
  const streaming = answer.status === "streaming";
  const { lead, options } = helpParts(answer, help.kind);
  const items = [...lead, ...options];
  const numbers = citationNumbers(
    items,
    (marker) => streaming || answer.citations.some((each) => each.marker === marker),
  );
  const starts = new Map(
    [
      ...callStarts(
        citedIn(answer, numbers).map(({ citation }) => citation),
        meetings,
        meetings.find(isLive)?.transcript?.documentId ?? null,
      ),
    ].map(([documentId, startedAt]) => [documentId, startedLabel(startedAt, t, language)]),
  );
  return (
    <div
      data-testid="help-suggestion"
      data-status={answer.status}
      aria-busy={streaming}
      className="help-suggestion"
    >
      <HelpHeading kind={help.kind} heard={help.heard} />
      {items.map((item, index) => (
        <Item
          // biome-ignore lint/suspicious/noArrayIndexKey: the options are in the order written.
          key={index}
          item={item}
          answer={answer}
          numbers={numbers}
          starts={starts}
          said={HELP_SHAPE[help.kind] === "options" && item.effect !== null}
        />
      ))}
      {streaming && items.length < 2 && <HelpOutline count={items.length === 0 ? 2 : 1} />}
      {answer.status === "failed" && (
        <NoHelp testId="help-failed" message={why} onRetry={onRetry} />
      )}
      {answer.status === "done" && items.length === 0 && (
        <NoHelp testId="help-nothing" message={t("meetings.help.nothing")} onRetry={onRetry} />
      )}
      {answer.status === "stopped" && options.length === 0 && (
        <NoHelp testId="help-stopped" message={t("answer.status.stopped")} onRetry={onRetry} />
      )}
      <Sources answer={answer} numbers={numbers} starts={starts} />
    </div>
  );
}
