import { useRef } from "react";
import type { ConversationAnswer, MarkedCitation } from "../../../../core/api";
import { badgeMessage, citationSource } from "../../../../shared/citations";
import {
  cellsText,
  type Moment,
  momentFound,
  momentWords,
  type QuoteLine,
  quoteLines,
  quoteState,
} from "../../../../shared/helpQuotes";
import type { ReplyPiece } from "../../../../shared/helpReplyRead";
import { formatLocation, isTranscriptLocation } from "../../../../shared/locations";
import { useT } from "../../i18n";
import { CheckLineIcon } from "../lineIcons";
import { TipPopover } from "../TipPopover";
import { useTip } from "../useTip";

/** Stands for a place's name in a Citation card's words, so the words around it never shorten. */
const NAME = "\u0000";

const citationOf = (answer: ConversationAnswer, marker: number) =>
  answer.citations.find((each) => each.marker === marker);

interface Shown {
  answer: ConversationAnswer;
  numbers: ReadonlyMap<number, number>;
  starts: ReadonlyMap<string, string>;
}

/** A Citation's number as a quote line repeats it, plain: its source on hover. */
function QuoteNumber({ marker, answer, numbers, starts }: Shown & { marker: number }) {
  const t = useT();
  const number = numbers.get(marker);
  if (number === undefined) return null;
  const citation = citationOf(answer, marker);
  const source = citation ? citationSource(citation, t).text : null;
  const started = (citation && starts.get(citation.documentId)) ?? null;
  return (
    <span
      data-testid="help-quote-number"
      title={
        source && started
          ? t("citation.where", { document: source, location: started })
          : (source ?? undefined)
      }
      className="help-quote-number"
    >
      {number}
    </span>
  );
}

/** The room a ✓ keeps until its words are found, so nothing beside it moves when it comes. */
const FoundRoom = () => (
  <span aria-hidden="true" className="help-quote-found help-quote-found--room">
    <CheckLineIcon />
  </span>
);

/**
 * The ✓ of words the app found word for word in `citation`'s place, which says so in the Citation
 * card's words: on hover and on the keyboard's focus in the shared tip, and to a screen reader.
 */
function Found({ citation }: { citation: MarkedCitation }) {
  const t = useT();
  const trigger = useRef<HTMLSpanElement>(null);
  const tip = useTip(trigger);
  const { key, params } = badgeMessage({ check: "found", reason: null }, citation, t);
  const said = t(key, params);
  return (
    <>
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: a click only opens the tip, which the keyboard opens on the focus. */}
      <span
        ref={trigger}
        data-testid="help-quote-found"
        role="img"
        aria-label={said}
        // biome-ignore lint/a11y/noNoninteractiveTabindex: Tab must reach the ✓ to show what it means.
        tabIndex={0}
        onFocus={tip.show}
        onBlur={tip.blur}
        onClick={tip.show}
        onPointerMove={tip.point}
        onPointerLeave={tip.leave}
        className="help-quote-found"
      >
        <CheckLineIcon aria-hidden="true" />
      </span>
      {tip.shown && trigger.current && (
        <TipPopover anchor={trigger.current} tip={tip}>
          {said}
        </TipPopover>
      )}
    </>
  );
}

/**
 * The words a Citation's card uses for a quote not found, that can't be checked, or that nothing
 * stored proves found ("Not checked", whatever was stored while the reply was cut off), with no ✓
 * (#2847). Past its room, the place's name is cut at its end, never the words around it.
 */
function CardWords({
  citation,
  state,
}: {
  citation: MarkedCitation;
  state: "not-found" | "cant-check" | "not-checked";
}) {
  const t = useT();
  const { key, params } = badgeMessage(
    { check: state, reason: state === citation.check ? citation.checkReason : null },
    citation,
    t,
  );
  const name = params?.document ?? params?.location;
  if (name === undefined) return <span className="help-quote-said">{t(key, params)}</span>;
  const [before = "", after = ""] = t(key, { ...params, document: NAME, location: NAME }).split(
    NAME,
  );
  return (
    <span title={t(key, params)} className="help-quote-said">
      <span className="help-quote-said-fixed">{before}</span>
      <span className="help-quote-said-name">{name}</span>
      <span className="help-quote-said-fixed">{after}</span>
    </span>
  );
}

/** A Citation of the call's own time, as a moment line shows it: "12:04". */
function useTimeOf(): (citation: MarkedCitation | undefined) => string | null {
  const t = useT();
  return (citation) =>
    citation?.location && isTranscriptLocation(citation.location)
      ? formatLocation(citation.location, t, { speaker: false })
      : null;
}

/**
 * One quote line: the quote and its numbers with ✓, the card's words, or the room it keeps. As a
 * reading's moment (`moment`), the quote comes after its Citation's own time.
 */
function QuoteRow({ line, moment, ...shown }: Shown & { line: QuoteLine; moment: boolean }) {
  const timeOf = useTimeOf();
  const citation = citationOf(shown.answer, line.drawn);
  const time = moment ? timeOf(citation) : null;
  return (
    <span
      data-testid={moment ? "help-moment" : "help-quote"}
      data-state={line.state}
      className={moment ? "help-option-note help-moment" : "help-quote"}
    >
      {line.state === "waiting" && <span aria-hidden="true" className="help-quote-room" />}
      {line.state === "found" && (
        <span className="help-quote-words">
          {time && `${time} `}
          {line.cells ? cellsText(line.cells) : `“${line.quote}”`}
        </span>
      )}
      {line.state !== "found" && line.state !== "waiting" && citation && (
        <CardWords citation={citation} state={line.state} />
      )}
      <span className="help-quote-marks">
        {line.markers.map((marker) => (
          <QuoteNumber key={marker} marker={marker} {...shown} />
        ))}
        {line.state === "found" && citation && <Found citation={citation} />}
        {line.more.map((marker) => (
          <QuoteNumber key={marker} marker={marker} {...shown} />
        ))}
      </span>
    </span>
  );
}

/**
 * The quote lines under a line of a help reply that carries Citation numbers (#2847): each
 * Citation's quote, word for word, with ✓ only where it was found; two at most, a third and later
 * Citation's numbers at the end of the second. As a reading's moment with several Citations
 * (`moment`), they stand in that line's place, each after its Citation's own time.
 */
export function QuoteRows({
  markers,
  moment = false,
  ...shown
}: Shown & { markers: readonly number[]; moment?: boolean }) {
  const lines = quoteLines(
    markers,
    (marker) => citationOf(shown.answer, marker),
    shown.answer.status,
    (marker) => shown.numbers.has(marker),
  );
  return (
    <>
      {lines.map((line) => (
        // A joined number comes after the line's first, so the line stays the same element.
        <QuoteRow key={line.markers[0]} line={line} moment={moment} {...shown} />
      ))}
    </>
  );
}

/** The place of a reading's moment line still being written: a room, since its kind isn't known yet. */
export const MomentRoom = () => (
  <span data-testid="help-moment" data-state="waiting" className="help-option-note help-moment">
    <span aria-hidden="true" className="help-quote-room" />
  </span>
);

/**
 * A plain moment of the call, which keeps the model's own words (#2847): its time, its quotation and
 * its number, with ✓ once the app finds the quoted words word for word in the cited place, its room
 * kept till then. Once its Citation has come, the time is the cited place's own. Where the app finds
 * the words aren't there, the Citation's own quote takes their place.
 */
export function PlainMoment({
  pieces,
  moment,
  ...shown
}: Shown & { pieces: readonly ReplyPiece[]; moment: Extract<Moment, { kind: "plain" }> }) {
  const timeOf = useTimeOf();
  const citation = citationOf(shown.answer, moment.marker);
  if (citation?.check === "not-found" && citation.checkReason === "quoted-words-not-on-pages") {
    return <QuoteRows markers={[moment.marker]} moment {...shown} />;
  }
  const found = citation !== undefined && momentFound(moment.words, citation);
  const words = momentWords(
    pieces.flatMap((piece) => (piece.kind === "text" ? [piece.text] : [])).join(""),
    timeOf(citation),
  );
  return (
    <span
      data-testid="help-moment"
      data-state={
        found
          ? "found"
          : quoteState(citation, shown.answer.status) === "waiting"
            ? "waiting"
            : "written"
      }
      className="help-option-note help-moment"
    >
      <span className="help-quote-words">{words}</span>
      <span className="help-quote-marks">
        <QuoteNumber marker={moment.marker} {...shown} />
        {found && citation ? <Found citation={citation} /> : <FoundRoom />}
      </span>
    </span>
  );
}
