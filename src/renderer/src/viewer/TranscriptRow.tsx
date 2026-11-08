import { Fragment, type KeyboardEvent, useEffect, useRef } from "react";
import type { Document, TranscriptSpeakers } from "../../../core/api";
import type { Cue } from "../../../core/documents/formats/vtt";
import { clockTime, paddedClockTime } from "../../../shared/clock";
import { type LinePart, shownSpeaker, type TranscriptLine } from "../../../shared/speakers";
import { atTime } from "../../../shared/wordTimes";
import { PlusLineIcon } from "../components/lineIcons";
import { SpeakerMenu } from "../components/meetings/SpeakerMenu";
import { useT } from "../i18n";
import type { SpeakersStep } from "../store";
import { useTranscriptPlayer } from "../transcriptPlayer";
import type { WordPiece } from "./transcriptWords";

/** A line as the Transcript shows it: a file's line, or a part of one the User split (#138). */
export interface PartRow {
  /** Names it: two lines can start together, so its start alone doesn't. */
  id: string;
  part: LinePart;
  /** Its file's line. */
  cue: Cue;
  pieces: WordPiece[];
}

/** Within this of the view's foot, the line being played is brought up. */
const FOOT_PX = 70;

/** A part's words, the one being played washed and the caret before the one it is at. */
function PartWords({
  row,
  meetingId,
  playable,
  caretAt,
}: {
  row: PartRow;
  meetingId: string | null;
  playable: boolean;
  caretAt: number | null;
}) {
  const t = useT();
  const text = useRef<HTMLParagraphElement>(null);
  const playingAt = useTranscriptPlayer((state) => {
    const playback = state.playback;
    const { part, cue, pieces } = row;
    if (!playback || playback.meetingId !== meetingId) return null;
    if (playback.positionMs < part.startMs || playback.positionMs >= part.endMs) return null;
    const at = atTime(cue, playback.positionMs);
    return (pieces.findLast((piece) => piece.word && piece.at <= at) ?? pieces[0])?.at ?? null;
  });
  const reached = playingAt !== null;
  // The caret's word says what Enter does there; a line's other words, while its audio is kept,
  // that a click plays from them.
  const wordTitle = (at: number) =>
    caretAt === at
      ? t(playable ? "transcript.word.playOrSplit" : "transcript.word.split")
      : playable
        ? t("transcript.word.play")
        : undefined;
  useEffect(() => {
    const line = text.current?.closest("li");
    const scroller = line?.closest<HTMLElement>("[data-testid='viewer-transcript']");
    if (!reached || !line || !scroller) return;
    const shown = line.getBoundingClientRect();
    const view = scroller.getBoundingClientRect();
    if (shown.bottom > view.bottom - FOOT_PX || shown.top < view.top) {
      scroller.scrollTop += shown.top - view.top - view.height / 3;
    }
  }, [reached]);
  return (
    <p ref={text} className="transcript-text">
      {row.pieces.map((piece) =>
        piece.word ? (
          <span
            key={piece.at}
            data-word=""
            data-at={piece.at}
            data-playable={playable || undefined}
            data-playing={playingAt === piece.at || undefined}
            data-caret={caretAt === piece.at || undefined}
            title={wordTitle(piece.at)}
            className="transcript-word"
          >
            {piece.text}
          </span>
        ) : (
          <Fragment key={piece.at}>{piece.text}</Fragment>
        ),
      )}
    </p>
  );
}

/**
 * A line of a Transcript (#136): its time, who speaks it (a menu on a saved Meeting's, #138), its
 * words and Add to note (#139). Clicking a word puts the caret there and, while the audio is
 * kept, plays from it.
 */
export function TranscriptRow({
  row,
  meetingId,
  focusable,
  hintId,
  nameable,
  lines,
  speakers,
  playable,
  caretAt,
  rest,
  onFocus,
  onKeyDown,
  onWord,
  onAdd,
}: {
  row: PartRow;
  meetingId: string | null;
  /** In the Tab order: the line the User is on, else the first. */
  focusable: boolean;
  hintId: string;
  nameable: Document | null;
  lines: readonly TranscriptLine[];
  speakers: TranscriptSpeakers | null;
  playable: boolean;
  caretAt: number | null;
  rest: { step: SpeakersStep; done(): void } | null;
  onFocus(row: PartRow): void;
  onKeyDown(event: KeyboardEvent<HTMLElement>, row: PartRow): void;
  onWord(row: PartRow, at: number): void;
  onAdd(row: PartRow): void;
}) {
  const t = useT();
  const { part, id } = row;
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: its keys are the line's own, in onKeyDown
    <li
      data-testid="transcript-line"
      data-start={part.startMs}
      data-line={id}
      tabIndex={meetingId ? (focusable ? 0 : -1) : undefined}
      aria-describedby={meetingId ? hintId : undefined}
      onFocus={() => onFocus(row)}
      onKeyDown={meetingId ? (event) => onKeyDown(event, row) : undefined}
      onClick={(event) => {
        const word = (event.target as Element).closest<HTMLElement>("[data-word]");
        if (!word || !meetingId || !window.getSelection()?.isCollapsed) return;
        onWord(row, Number(word.dataset.at));
      }}
      className="transcript-line group"
    >
      <span data-quote-skip="" className="transcript-time">
        {paddedClockTime(part.startMs)}
      </span>
      <div className="min-w-0">
        {row.cue.speaker &&
          (nameable ? (
            <SpeakerMenu
              document={nameable}
              lines={lines}
              line={{ startMs: part.startMs, label: part.label }}
              rest={rest}
            />
          ) : (
            <p data-testid="transcript-speaker" data-quote-skip="" className="transcript-speaker">
              {shownSpeaker(speakers, part.startMs, part.label, t)}
            </p>
          ))}
        <PartWords row={row} meetingId={meetingId} playable={playable} caretAt={caretAt} />
      </div>
      {meetingId && (
        <button
          type="button"
          tabIndex={-1}
          data-testid="transcript-add"
          data-quote-skip=""
          aria-label={t("transcript.addToNote.line", {
            time: clockTime(part.startMs),
            text: part.text,
          })}
          title={t(caretAt === null ? "transcript.addToNote.withKey" : "transcript.addToNote")}
          onClick={() => onAdd(row)}
          className="transcript-add"
        >
          <PlusLineIcon className="size-3.5" />
          <span className="transcript-add-word">{t("transcript.addToNote")}</span>
        </button>
      )}
    </li>
  );
}
