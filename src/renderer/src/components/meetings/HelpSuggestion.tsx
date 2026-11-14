import { type ReactNode, useEffect, useState } from "react";
import type {
  CitationCheckReason,
  ConversationAnswer,
  MarkedCitation,
  MeetingHelp,
  MeetingHelpKind,
} from "../../../../core/api";
import { citationSource, citedLocation } from "../../../../shared/citations";
import { withFigureText } from "../../../../shared/figureMarkers";
import { lineText, markersOf, momentBegun, momentOf } from "../../../../shared/helpQuotes";
import type { ReplyItem, ReplyPiece } from "../../../../shared/helpReplyRead";
import { isTranscriptLocation } from "../../../../shared/locations";
import {
  HELP_SHAPE,
  helpLabel,
  LINE_MARK,
  plainLine,
  RECOMMENDED_MARK,
} from "../../../../shared/meetingHelp";
import { isTheirs, SPEAKER_ME } from "../../../../shared/speakers";
import { CJK } from "../../../../shared/text";
import { useAnswers } from "../../answers";
import { useCallStarts } from "../../callStarts";
import { core } from "../../core";
import { citationNumbers, helpParts, quoted } from "../../helpReply";
import {
  type DrawnReply,
  type EndedLine,
  type LinePlace,
  lineKey,
  replyAtEnd,
} from "../../helpReplyEnd";
import { useT } from "../../i18n";
import { useModelNames, useServiceName } from "../../modelNames";
import { answerProblem } from "../../problems";
import { DocumentLineIcon } from "../lineIcons";
import { KeptQuote, MomentRoom, PlainMoment, QuoteLineRows, QuoteRows } from "./HelpQuotes";

/**
 * A help Answer, as the core writes it: loaded once, then each write as it streams. Only this
 * help's: never the Answer of a help before it, for which a load may still come back (#3005).
 */
export function useHelpAnswer(
  help: { conversationId: string; answerId: string } | null,
): ConversationAnswer | null {
  const [answer, setAnswer] = useState<ConversationAnswer | null>(null);
  const conversationId = help?.conversationId;
  const answerId = help?.answerId;
  useEffect(() => {
    if (!conversationId || !answerId) return;
    let live = true;
    const stop = core.on("conversation.message", (message) => {
      if (live && message.kind === "answer" && message.id === answerId) setAnswer(message);
    });
    core.getConversation(conversationId).then(
      ({ messages }) => {
        const found = messages.find((message) => message.id === answerId);
        if (live && found?.kind === "answer") {
          setAnswer((now) => (now?.id === answerId ? now : found));
        }
      },
      // Deleted meanwhile: the panel shows no suggestion.
      () => undefined,
    );
    return () => {
      live = false;
      stop();
    };
  }, [conversationId, answerId]);
  return answer !== null && answer.id === answerId ? answer : null;
}

/**
 * Why a quote wasn't found or can't be checked, where the Citation card says it in one line: a
 * Folder kept inside or a word a scan may have misread the card says otherwise.
 */
const SAID_WHY = [
  "quote-not-on-pages",
  "quoted-words-not-on-pages",
  "pages-outside-passage",
  "too-many-pages",
  "in-several-places",
  "no-text",
  "picture",
  "document-removed",
] as const satisfies readonly CitationCheckReason[];

/**
 * A Citation's number in a line the model wrote: a plain source, never a ✓ (#2847). Its quote's
 * state shows as main shows it, not found among them, with why on hover.
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
  const source = citation ? citationSource(citation, t).text : null;
  const pointsTo =
    source && started ? t("citation.where", { document: source, location: started }) : source;
  const reason =
    citation?.check === "not-found" || citation?.check === "cant-check"
      ? SAID_WHY.find((each) => each === citation.checkReason)
      : undefined;
  const why = reason && t(`citation.reason.${reason}`);
  return (
    <span
      data-testid="help-citation"
      data-check={citation?.check ?? "checking"}
      data-marker={citation?.marker}
      data-at={at}
      title={pointsTo ? [pointsTo, why].filter(Boolean).join("\n") : undefined}
      className="help-citation"
    >
      {number}
    </span>
  );
}

/** The end of a line's words that no row may break: its last word, or its last Chinese character. */
const LAST_WORD = new RegExp(`([${CJK}]?[^\\s${CJK}]*)(\\s*)$`, "u");

/**
 * A line's words and numbers. Once its reply has ended (`ended`), as it was written: each number
 * where it stood, one that stands for no Citation now kept as room, and the end's own numbers after
 * its last word, taking no room of the line's own (#3098): every line keeps that room at its end.
 */
function Pieces({
  pieces,
  answer,
  numbers,
  starts,
  ended,
}: {
  pieces: readonly ReplyPiece[];
  answer: ConversationAnswer;
  numbers: ReadonlyMap<number, number>;
  starts: ReadonlyMap<string, string>;
  ended?: EndedLine;
}) {
  const chip = (marker: number, at: number, key: string) => {
    const citation = answer.citations.find((each) => each.marker === marker);
    const number = numbers.get(marker);
    // A marker with no Citation is left out, as the assistant shows an Answer.
    if (number === undefined) return null;
    return (
      <CitationChip
        key={key}
        citation={citation}
        number={number}
        at={at}
        started={(citation && starts.get(citation.documentId)) ?? null}
      />
    );
  };
  const drawn = (piece: ReplyPiece, key: string): ReactNode => {
    if (piece.kind === "text") return <span key={key}>{piece.text}</span>;
    // Figures are written into the text before it is read (`withFigureText`).
    if (piece.kind === "figure") return null;
    const gone = ended?.gone.get(piece.marker);
    if (gone !== undefined) {
      return (
        <span key={key} aria-hidden="true" className="help-citation help-citation--gone">
          {gone}
        </span>
      );
    }
    return chip(ended?.shown.get(piece.marker) ?? piece.marker, piece.at, key);
  };
  const late = ended?.late ?? [];
  if (late.length === 0) {
    return (
      <span className="help-line-words">
        {pieces.map((piece, index) => drawn(piece, `${piece.kind}-${index}`))}
      </span>
    );
  }
  const numbersAtEnd = (
    <span key="late" className="help-citation-late">
      {late.map((marker) => chip(marker, -1, `late-${marker}`))}
    </span>
  );
  // The end's numbers hold to the last thing drawn, so no row can break before them.
  let last = pieces.length - 1;
  const shows = (piece: ReplyPiece, at: number) =>
    piece.kind === "text" ? piece.text.trim() !== "" : drawn(piece, String(at)) !== null;
  for (; last >= 0; last--) {
    const piece = pieces[last];
    if (piece && shows(piece, last)) break;
  }
  const lastPiece = pieces[last];
  const nodes = pieces
    .slice(0, Math.max(0, last))
    .map((piece, index) => drawn(piece, `${piece.kind}-${index}`));
  if (lastPiece?.kind === "text") {
    const [, word = "", space = ""] = LAST_WORD.exec(lastPiece.text) ?? [];
    const head = lastPiece.text.slice(0, lastPiece.text.length - word.length - space.length);
    nodes.push(
      <span key={`text-${last}`}>{head}</span>,
      <span key="end" className="help-line-end">
        {word}
        {numbersAtEnd}
      </span>,
      <span key="space">{space}</span>,
    );
  } else {
    nodes.push(
      <span key="end" className="help-line-end">
        {lastPiece && drawn(lastPiece, `${lastPiece.kind}-${last}`)}
        {numbersAtEnd}
      </span>,
    );
  }
  nodes.push(...pieces.slice(last + 1).map((piece, index) => drawn(piece, `after-${index}`)));
  return <span className="help-line-words">{nodes}</span>;
}

/**
 * One of a reply's lines and the quote lines under it (#2847). A reading's moment of the call is
 * drawn by its kind (`momentOf`): a plain one keeps its words and takes its ✓ where it stands, one
 * quotation with several Citations is drawn by the app from them; while a line that may be a moment
 * is still written, its place is a room, so no words shown there are replaced.
 */
function ReplyLine({
  pieces,
  testId,
  className,
  reading,
  open,
  answer,
  numbers,
  starts,
  ended,
}: {
  pieces: readonly ReplyPiece[];
  testId: string;
  className: string;
  /** A reading's line, where a moment of the call may be drawn by the app. */
  reading: boolean;
  /** The reply's last line while it is still written. */
  open: boolean;
  answer: ConversationAnswer;
  numbers: ReadonlyMap<number, number>;
  starts: ReadonlyMap<string, string>;
  /** The line as it was written, once the reply has ended in the panel that showed it written. */
  ended?: EndedLine | undefined;
}) {
  if (ended) {
    const late = ended.late.length > 0 && className === "help-option-note";
    return (
      <>
        <span
          data-testid={testId}
          className={late ? `${className} help-option-note--late` : className}
        >
          <Pieces
            pieces={ended.pieces}
            answer={answer}
            numbers={numbers}
            starts={starts}
            ended={ended}
          />
        </span>
        <KeptRows ended={ended} answer={answer} numbers={numbers} starts={starts} />
      </>
    );
  }
  if (reading && open && momentBegun(pieces)) return <MomentRoom />;
  const moment = reading && !open ? momentOf(pieces) : null;
  if (moment?.kind === "plain") {
    return (
      <PlainMoment
        pieces={pieces}
        moment={moment}
        answer={answer}
        numbers={numbers}
        starts={starts}
      />
    );
  }
  if (moment?.kind === "several") {
    return (
      <QuoteRows
        markers={moment.markers}
        moment
        answer={answer}
        numbers={numbers}
        starts={starts}
      />
    );
  }
  return (
    <>
      <span data-testid={testId} className={className}>
        <Pieces pieces={pieces} answer={answer} numbers={numbers} starts={starts} />
      </span>
      <QuoteRows markers={markersOf([pieces])} answer={answer} numbers={numbers} starts={starts} />
    </>
  );
}

/** A line's kept quote rows once its reply has ended, drawn as `ReplyLine` draws them. */
function KeptRows({ ended, ...shown }: Shown & { ended: EndedLine }) {
  return (
    <>
      <QuoteLineRows lines={ended.rows} {...shown} />
      {Array.from({ length: ended.missing + ended.empty }, (_, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: kept rows, in the order they were kept.
        <KeptQuote key={index} empty={index >= ended.missing} />
      ))}
    </>
  );
}

interface Shown {
  answer: ConversationAnswer;
  numbers: ReadonlyMap<number, number>;
  starts: ReadonlyMap<string, string>;
}

function Item({
  item,
  open,
  reading,
  answer,
  numbers,
  starts,
  ended,
}: Shown & {
  item: ReplyItem;
  /** Which of its lines is the reply's last while it is still written, if any. */
  open: LinePlace | null;
  reading: boolean;
  /** Each of its lines as it was written, once the reply has ended in the panel that showed it. */
  ended: (place: LinePlace) => EndedLine | undefined;
}) {
  const t = useT();
  const effect = ended("effect");
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
      <ReplyLine
        pieces={item.said ? quoted(item.lead) : item.lead}
        testId="help-option-say"
        className="help-option-say"
        reading={reading && !item.said}
        open={open === "lead"}
        answer={answer}
        numbers={numbers}
        starts={starts}
        ended={ended("lead")}
      />
      {item.notes.map((note, index) => (
        <ReplyLine
          // biome-ignore lint/suspicious/noArrayIndexKey: a reading's notes are in the order written.
          key={index}
          pieces={note}
          testId="help-option-note"
          className="help-option-note"
          reading={reading}
          open={open === index}
          answer={answer}
          numbers={numbers}
          starts={starts}
          ended={ended(index)}
        />
      ))}
      {item.effect && (
        <>
          <span data-testid="help-option-effect" className="help-option-effect">
            →{" "}
            <Pieces
              pieces={effect?.pieces ?? item.effect}
              answer={answer}
              numbers={numbers}
              starts={starts}
              ended={effect}
            />
          </span>
          {effect ? (
            <KeptRows ended={effect} answer={answer} numbers={numbers} starts={starts} />
          ) : (
            <QuoteRows
              markers={markersOf([item.effect])}
              answer={answer}
              numbers={numbers}
              starts={starts}
            />
          )}
        </>
      )}
    </div>
  );
}

/**
 * Which line of the last shown item is the reply's last while it is still written: the line the
 * text ends on, with no line break after it yet.
 */
function openLine(
  text: string,
  status: ConversationAnswer["status"],
  item: ReplyItem | undefined,
): "lead" | number | "effect" | null {
  if (status !== "streaming" || !item || text.endsWith("\n")) return null;
  const last = plainLine(text.slice(text.lastIndexOf("\n") + 1))
    .replace(RECOMMENDED_MARK, "")
    .replace(LINE_MARK, "")
    .trim();
  const same = (pieces: readonly ReplyPiece[]) => lineText(pieces).trim() === last;
  if (item.effect) return null;
  const note = item.notes.length - 1;
  if (note >= 0) return same(item.notes[note] ?? []) ? note : null;
  return same(item.lead) ? "lead" : null;
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
  const { items, options, open } = drawnItems(answer, help.kind);
  const reading = HELP_SHAPE[help.kind] === "readings";
  const written = useAsWritten(answer);
  const end = written && endOf(written, answer, help.kind, items);
  const numbers =
    end?.numbers ??
    citationNumbers(
      items,
      (marker) => streaming || answer.citations.some((each) => each.marker === marker),
    );
  const starts = useCallStarts(citedIn(answer, numbers).map(({ citation }) => citation));
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
          open={index === items.length - 1 ? open : null}
          reading={reading}
          answer={answer}
          numbers={numbers}
          starts={starts}
          ended={(place) => end?.lines.get(lineKey(index, place))}
        />
      ))}
      {streaming && items.length < 2 && <HelpOutline count={items.length === 0 ? 2 : 1} />}
      {end && end.foot.length > 0 && (
        <div data-testid="help-foot" className="help-foot">
          <QuoteLineRows lines={end.foot} answer={answer} numbers={numbers} starts={starts} />
        </div>
      )}
      {answer.status === "failed" && (
        <NoHelp testId="help-failed" message={why} onRetry={onRetry} />
      )}
      {answer.status === "done" && items.length === 0 && (
        <NoHelp testId="help-nothing" message={t("meetings.help.nothing")} onRetry={onRetry} />
      )}
      {answer.status === "stopped" && options.length === 0 && (
        <NoHelp testId="help-stopped" message={t("answer.status.stopped")} onRetry={onRetry} />
      )}
      {/* Once the reply ends, under the end's own quote lines: nothing shown moves for them. */}
      {!streaming && <Sources answer={answer} numbers={numbers} starts={starts} />}
    </div>
  );
}

/** A reply's items as the panel draws them, and which line of its last is still written. */
function drawnItems(answer: ConversationAnswer, kind: MeetingHelpKind) {
  // A figure's own text is written in before the reply is read, so a word the model wrote before
  // it ("about") isn't doubled.
  const text = withFigureText(
    answer.text,
    (marker) => answer.figures.find((each) => each.marker === marker) ?? null,
  );
  const { lead, options } = helpParts({ ...answer, text }, kind);
  const items = [...lead, ...options];
  return { items, options, open: openLine(text, answer.status, items.at(-1)) };
}

/**
 * The reply as this panel last drew it being written, once it has ended (#3098); null while it is
 * written, and for a reply this panel didn't see written: one drawn anew.
 */
function useAsWritten(answer: ConversationAnswer): ConversationAnswer | null {
  const [written, setWritten] = useState<ConversationAnswer | null>(null);
  const next = answer.status === "streaming" ? answer : written?.id === answer.id ? written : null;
  if (next !== written) setWritten(next);
  return answer.status === "done" ? next : null;
}

/** The ended reply drawn as the panel drew it written: each line keeps its rows. */
function endOf(
  written: ConversationAnswer,
  ended: ConversationAnswer,
  kind: MeetingHelpKind,
  items: readonly ReplyItem[],
) {
  const before = drawnItems(written, kind);
  const reply = (answer: ConversationAnswer, shown: readonly ReplyItem[]): DrawnReply => ({
    items: shown,
    citationOf: (marker) => answer.citations.find((each) => each.marker === marker),
    numbered: (marker) =>
      answer.status === "streaming" || answer.citations.some((each) => each.marker === marker),
    status: answer.status,
  });
  const last = before.items.length - 1;
  return replyAtEnd(reply(written, before.items), reply(ended, items), {
    reading: HELP_SHAPE[kind] === "readings",
    open: before.open === null ? null : lineKey(last, before.open),
  });
}
