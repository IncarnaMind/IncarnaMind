import { Fragment, type KeyboardEvent, useEffect, useRef, useState } from "react";
import type { Document, TranscriptSpeakers } from "../../../core/api";
import type { Cue } from "../../../core/documents/formats/vtt";
import { clockTime, paddedClockTime } from "../../../shared/clock";
import { type LinePart, shownSpeaker, type TranscriptLine } from "../../../shared/speakers";
import { joinsUnspaced } from "../../../shared/transcriptTurns";
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

/**
 * The pointer rests this long on a line before Add to note moves to it: on the way to the button
 * it crosses the next line on the same row, which must not become the one added.
 */
const AIM_REST_MS = 80;

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
  const text = useRef<HTMLSpanElement>(null);
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
    const line = text.current?.closest<HTMLElement>("[data-line]");
    const scroller = line?.closest<HTMLElement>("[data-testid='viewer-transcript']");
    if (!reached || !line || !scroller) return;
    const shown = line.getBoundingClientRect();
    const view = scroller.getBoundingClientRect();
    if (shown.bottom > view.bottom - FOOT_PX || shown.top < view.top) {
      scroller.scrollTop += shown.top - view.top - view.height / 3;
    }
  }, [reached]);
  return (
    <span ref={text}>
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
    </span>
  );
}

/** A turn as the Transcript shows it: one Speaker's lines, in paragraphs (../../../shared/transcriptTurns). */
export interface TurnRow {
  /** Names it while it grows: its first line's id. */
  id: string;
  startMs: number;
  /** Its Speaker, as its lines have it now; null for lines that name no one. */
  speaker: string | null;
  paragraphs: PartRow[][];
}

/** Words being said, not yet final: at the end of the turn they go on, greyed. */
export interface Saying {
  text: string;
}

/**
 * A turn of a Transcript, as a script shows it (#136, #138): its time and Speaker once (a menu on
 * a saved Meeting's), then its lines, each a sentence the User can focus, add to the note (#139),
 * play from a word and split at one. Its lines run on in paragraphs; a line the transcriber cut
 * inside a sentence reads on without a break.
 */
export function TranscriptTurn({
  turn,
  meetingId,
  focused,
  hintId,
  nameable,
  lines,
  speakers,
  playable,
  caret,
  rest,
  saying,
  onFocus,
  onKeyDown,
  onWord,
  onAdd,
}: {
  turn: TurnRow;
  meetingId: string | null;
  /** The line in the Tab order: the one the User is on, else the first. */
  focused: string | undefined;
  hintId: string;
  nameable: Document | null;
  lines: readonly TranscriptLine[];
  speakers: TranscriptSpeakers | null;
  playable: boolean;
  caret: { line: string; at: number } | null;
  rest: { step: SpeakersStep; done(): void } | null;
  saying: Saying | null;
  onFocus(row: PartRow): void;
  onKeyDown(event: KeyboardEvent<HTMLElement>, row: PartRow): void;
  onWord(row: PartRow, at: number): void;
  onAdd(row: PartRow): void;
}) {
  const t = useT();
  const body = useRef<HTMLDivElement>(null);
  const rows = turn.paragraphs.flat();
  const first = rows[0] as PartRow;
  // The line Add to note adds: the one the pointer or the focus is on, its button beside it.
  const [aim, setAim] = useState<{ id: string; top: number } | null>(null);
  const aimed = rows.find((row) => row.id === aim?.id) ?? first;
  const aimAt = (row: PartRow, element: HTMLElement) => {
    const top = body.current?.getBoundingClientRect().top ?? 0;
    setAim({ id: row.id, top: Math.max(0, element.getBoundingClientRect().top - top) });
  };
  const resting = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stopAiming = () => {
    if (resting.current) clearTimeout(resting.current);
    resting.current = null;
  };
  useEffect(
    () => () => {
      if (resting.current) clearTimeout(resting.current);
    },
    [],
  );
  const aimWhenResting = (row: PartRow, element: HTMLElement) => {
    stopAiming();
    if (aim?.id === row.id) return;
    if (!aim) aimAt(row, element);
    else resting.current = setTimeout(() => aimAt(row, element), AIM_REST_MS);
  };
  const turnLines = rows.flatMap((row) =>
    row.cue.speaker === null ? [] : [{ startMs: row.part.startMs, label: row.part.label }],
  );
  return (
    <li
      data-testid="transcript-turn"
      data-turn={turn.id}
      onPointerLeave={() => {
        stopAiming();
        setAim(null);
      }}
      className="transcript-turn group"
    >
      <span data-quote-skip="" className="transcript-time">
        {paddedClockTime(turn.startMs)}
      </span>
      <div ref={body} className="min-w-0">
        {turn.speaker !== null &&
          (nameable ? (
            <SpeakerMenu document={nameable} lines={lines} turn={turnLines} rest={rest} />
          ) : (
            <p data-testid="transcript-speaker" data-quote-skip="" className="transcript-speaker">
              {shownSpeaker(speakers, first.part.startMs, first.part.label, t)}
            </p>
          ))}
        {turn.paragraphs.map((paragraph, index) => (
          <p key={(paragraph[0] as PartRow).id} className="transcript-text">
            {paragraph.map((row, at) => {
              const before = at > 0 ? (paragraph[at - 1] as PartRow) : null;
              const caretAt = caret?.line === row.id ? caret.at : null;
              return (
                <Fragment key={row.id}>
                  {before && !joinsUnspaced(before.part.text, row.part.text) && " "}
                  {/* biome-ignore lint/a11y/noStaticElementInteractions: a line the keys move through, as the list's rows */}
                  <span
                    data-testid="transcript-line"
                    data-start={row.part.startMs}
                    data-line={row.id}
                    tabIndex={meetingId ? (focused === row.id ? 0 : -1) : undefined}
                    aria-describedby={meetingId ? hintId : undefined}
                    data-aimed={aim?.id === row.id ? "" : undefined}
                    onFocus={(event) => {
                      stopAiming();
                      onFocus(row);
                      aimAt(row, event.currentTarget);
                    }}
                    onPointerMove={(event) => aimWhenResting(row, event.currentTarget)}
                    onKeyDown={meetingId ? (event) => onKeyDown(event, row) : undefined}
                    onClick={(event) => {
                      const word = (event.target as Element).closest<HTMLElement>("[data-word]");
                      if (!word || !meetingId || !window.getSelection()?.isCollapsed) return;
                      onWord(row, Number(word.dataset.at));
                    }}
                    className="transcript-sentence"
                  >
                    <PartWords
                      row={row}
                      meetingId={meetingId}
                      playable={playable}
                      caretAt={caretAt}
                    />
                  </span>
                </Fragment>
              );
            })}
            {saying && index === turn.paragraphs.length - 1 && (
              <span
                data-testid="transcript-partial"
                data-quote-skip=""
                aria-live="polite"
                className="transcript-sentence--partial"
              >
                {joinsUnspaced((paragraph.at(-1) as PartRow).part.text, saying.text) ? "" : " "}
                {saying.text}
              </span>
            )}
          </p>
        ))}
      </div>
      {meetingId && (
        <button
          type="button"
          tabIndex={-1}
          data-testid="transcript-add"
          data-quote-skip=""
          aria-label={t("transcript.addToNote.line", {
            time: clockTime(aimed.part.startMs),
            text: aimed.part.text,
          })}
          title={t(
            caret?.line === aimed.id ? "transcript.addToNote" : "transcript.addToNote.withKey",
          )}
          onPointerEnter={stopAiming}
          onClick={() => onAdd(aimed)}
          style={{ marginTop: aim?.top ?? 0 }}
          className="transcript-add"
        >
          <PlusLineIcon className="size-3.5" />
          <span className="transcript-add-word">{t("transcript.addToNote")}</span>
        </button>
      )}
    </li>
  );
}
