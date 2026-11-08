import type { KeyboardEvent, ReactNode } from "react";
import {
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { Document, Meeting } from "../../../core/api";
import {
  type Cue,
  type GapReason,
  listedGaps,
  readVtt,
  type Transcript,
  type TranscriptGap,
  transcriptUnits,
} from "../../../core/documents/formats/vtt";
import { paddedClockTime } from "../../../shared/clock";
import type { MessageKey } from "../../../shared/i18n";
import {
  type FileLine,
  partsOf,
  speakerName,
  type TranscriptLine,
  withLineSplit,
} from "../../../shared/speakers";
import { timeAt } from "../../../shared/wordTimes";
import { transcriptHandle, useHandle } from "../commands/handles";
import { MicOffLineIcon } from "../components/lineIcons";
import { MetaLine } from "../components/MetaLine";
import { LineAction } from "../components/ProblemLine";
import { Tip } from "../components/Tip";
import { useDismissOnEscape } from "../escapeDismiss";
import { useLanguage, useT } from "../i18n";
import { isLive, useMeetings } from "../meetings";
import { durationLabel } from "../meetingTime";
import { type SpeakersStep, useAppStore, type ViewerTarget } from "../store";
import { closeTip, useFeatureTip } from "../tips";
import { addLineToNote, type LineAdded } from "../transcriptNotes";
import { useTranscriptPlayer } from "../transcriptPlayer";
import { useCitedArea } from "./citedArea";
import { loadDocumentBytes, MissingDocumentError } from "./documentBytes";
import { markQuote, textNodes, unmarkQuote } from "./domQuote";
import { FileStates } from "./FileStates";
import { CitationMark, marginRoom, markTopFor, quoteMarkOf, quoteTone } from "./quoteMark";
import { TranscriptPlayerBar } from "./TranscriptPlayerBar";
import { type PartRow, TranscriptRow } from "./TranscriptRow";
import { piecesBetween, wordPieces } from "./transcriptWords";
import type { LoadedFile } from "./useDocumentFile";
import { ViewerFrameContext, ViewerHeader } from "./ViewerHeader";
import { ViewerMessage } from "./ViewerMessage";

/** Within this of the bottom, the view follows new lines as they come. */
const FOLLOW_PX = 48;

const GAP_REASONS: Record<Exclude<GapReason, "muted">, MessageKey> = {
  restarted: "transcript.gap.restarted",
  sleep: "transcript.gap.sleep",
  interrupted: "transcript.gap.interrupted",
  lost: "transcript.gap.lost",
  uncaptured: "transcript.gap.uncaptured",
  permission: "transcript.gap.permission",
  stalled: "transcript.gap.stalled",
  cloud: "transcript.gap.cloud",
};

const read = (bytes: Uint8Array): Transcript => readVtt(new TextDecoder().decode(bytes));

const NO_LINES: Transcript = { cues: [], gaps: [] };

/**
 * The Transcript's file, read again whenever `version` changes, the last read
 * kept on screen meanwhile: a Meeting's lines arrive every few seconds. Before
 * its first line there is no file, and it has no lines.
 */
function useTranscriptFile(
  documentId: string | null,
  version: string,
): { loaded: LoadedFile<Transcript>; reload(): void } {
  const [loaded, setLoaded] = useState<LoadedFile<Transcript>>(
    documentId ? { kind: "loading" } : { kind: "ready", value: NO_LINES },
  );
  const [attempt, setAttempt] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `version` says when to read again
  useEffect(() => {
    if (!documentId) return;
    const controller = new AbortController();
    loadDocumentBytes(documentId, controller.signal)
      .then((bytes) => {
        if (!controller.signal.aborted) setLoaded({ kind: "ready", value: read(bytes) });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        if (error instanceof MissingDocumentError) setLoaded({ kind: "missing" });
        else
          setLoaded({
            kind: "failed",
            message: error instanceof Error ? error.message : String(error),
          });
      });
    return () => controller.abort();
  }, [documentId, version, attempt]);
  return { loaded, reload: () => setAttempt((count) => count + 1) };
}

/**
 * A Transcript (#136): its lines, each with its time, and its speaker once
 * speakers are told apart (#140). While its Meeting records, lines arrive a
 * few seconds behind, the speech being transcribed shows greyed at the end,
 * each side's at once, and the view follows them unless the User has scrolled
 * up. Opened at a Citation, the quote is washed in the line it was said in.
 */
export function TranscriptView({ document, target }: { document: Document; target: ViewerTarget }) {
  const meeting = useMeetings((state) =>
    state.meetings.find((each) => each.transcript?.documentId === document.id),
  );
  const { loaded, reload } = useTranscriptFile(
    document.id,
    `${document.contentHash}:${meeting?.transcript?.lines ?? 0}`,
  );
  return (
    <FileStates
      document={document}
      loaded={loaded}
      quote={target.quote}
      reload={reload}
      ready={(transcript) => (
        <TranscriptContent
          document={document}
          transcript={transcript}
          target={target}
          meetingId={meeting?.id ?? null}
        />
      )}
    />
  );
}

/**
 * A Meeting's Transcript in its Note's page (#138): its words from the first one said, before
 * the Transcript's Document is made with its first finished line, then its lines as they come.
 * `aside`: the page's own control at the header's end ("Open beside").
 */
export function MeetingTranscriptView({
  meeting,
  document,
  target,
  aside,
}: {
  meeting: Meeting;
  document: Document | undefined;
  target: ViewerTarget;
  aside?: ReactNode;
}) {
  const t = useT();
  const documentId = meeting.transcript?.documentId ?? null;
  const { loaded, reload } = useTranscriptFile(
    document ? document.id : null,
    `${document?.contentHash ?? ""}:${meeting.transcript?.lines ?? 0}`,
  );
  const content = (transcript: Transcript) => (
    <TranscriptContent
      document={document ?? null}
      transcript={transcript}
      target={target}
      meetingId={meeting.id}
      aside={aside}
    />
  );
  // While the call records, the words being said stay in view as its first line is filed.
  if (!document && documentId && !isLive(meeting)) {
    return (
      <>
        <ViewerHeader />
        <ViewerMessage>{t("viewer.loading")}</ViewerMessage>
      </>
    );
  }
  if (!document || loaded.kind === "ready") {
    return content(loaded.kind === "ready" ? loaded.value : NO_LINES);
  }
  return (
    <FileStates
      document={document}
      loaded={loaded}
      quote={target.quote}
      reload={reload}
      ready={content}
    />
  );
}

type Row =
  | ({ kind: "cue" } & PartRow)
  | { kind: "gap"; gap: TranscriptGap }
  | { kind: "microphone"; fromMs: number };

/** How long "Added to the note" shows in the header. */
const ADDED_SHOWN_MS = 3000;

/** Names a line: two can start together, so its start alone doesn't. */
const lineId = (startMs: number, endMs: number, speaker: string | null) =>
  `${startMs}-${endMs}-${speaker ?? ""}`;

const fileLineOf = (cue: Cue): FileLine => ({
  startMs: cue.startMs,
  endMs: cue.endMs,
  text: cue.text,
  label: cue.speaker ?? "",
});

/** The word before or after the caret, or the line's first or last when it has none. */
function wordBeside(
  list: HTMLElement,
  line: HTMLElement,
  at: number | null,
  direction: 1 | -1,
): HTMLElement | null {
  if (at === null) {
    const own = [...line.querySelectorAll<HTMLElement>("[data-word]")];
    return (direction === 1 ? own[0] : own.at(-1)) ?? null;
  }
  const words = [...list.querySelectorAll<HTMLElement>("[data-word]")];
  const index = words.findIndex(
    (word) => word.closest("[data-line]") === line && Number(word.dataset.at) === at,
  );
  return index < 0 ? null : (words[index + direction] ?? null);
}

const speakerButtonOf = (line: Element | null | undefined) =>
  line?.querySelector<HTMLButtonElement>("[data-speaker-button]") ?? null;

/** The line after or before this one: the Transcript's gaps between them aren't lines. */
function lineBeside(from: Element, direction: "next" | "previous"): HTMLElement | null {
  let each = direction === "next" ? from.nextElementSibling : from.previousElementSibling;
  while (each) {
    if (each instanceof HTMLElement && each.dataset.start !== undefined) return each;
    each = direction === "next" ? each.nextElementSibling : each.previousElementSibling;
  }
  return null;
}

const NOT_SAID: NonNullable<Meeting["transcript"]>["partials"] = [];

function TranscriptContent({
  document,
  transcript,
  target,
  meetingId,
  aside,
}: {
  document: Document | null;
  transcript: Transcript;
  target: ViewerTarget;
  meetingId: string | null;
  aside?: ReactNode;
}) {
  const t = useT();
  const language = useLanguage();
  const meeting = useMeetings((state) => state.meetings.find((each) => each.id === meetingId));
  const live = meeting?.status === "recording";
  const state = meeting?.transcript?.state;
  const partials = (live && state === "live" && meeting?.transcript?.partials) || NOT_SAID;
  const scroller = useRef<HTMLDivElement>(null);
  const column = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLOListElement>(null);
  const following = useRef(true);
  const [atEnd, setAtEnd] = useState(true);
  const [highlighted, setHighlighted] = useState(0);
  const [markTop, setMarkTop] = useState<number | null>(null);
  const [markRoom, setMarkRoom] = useState(0);
  const mark = quoteMarkOf(target.citation);
  const hintId = useId();
  const owner = useId();
  // The line the User is on, by its id: the one Enter, the button and ⌘K add.
  const [active, setActive] = useState<string | null>(null);
  const activeId = useRef<string | null>(null);
  // The word a click or Left and Right put the caret before (#138): Enter splits the line there.
  const [caret, setCaret] = useState<{ line: string; at: number } | null>(null);
  const caretRef = useRef(caret);
  caretRef.current = caret;
  const [rest, setRest] = useState<{ line: string; step: SpeakersStep; done(): void } | null>(null);
  const [added, setAdded] = useState<LineAdded | null>(null);

  const microphonePausedAtMs = meeting?.microphonePausedAtMs ?? null;
  const resumeMicrophone = () => {
    if (meetingId) void useMeetings.getState().setMicrophonePaused(meetingId, false);
  };
  const speakers = document?.speakers ?? null;
  const pieces = useMemo(
    () => new Map(transcript.cues.map((cue) => [cue, wordPieces(cue.text, language)])),
    [transcript, language],
  );
  const parts = useMemo<PartRow[]>(
    () =>
      transcript.cues.flatMap((cue) =>
        partsOf(speakers, fileLineOf(cue)).map((part, index, all) => ({
          id: lineId(part.startMs, part.endMs, cue.speaker),
          part,
          cue,
          pieces: piecesBetween(
            pieces.get(cue) ?? [],
            part.at,
            all[index + 1]?.at ?? cue.text.length,
          ),
        })),
      ),
    [transcript, speakers, pieces],
  );
  const partsRef = useRef(parts);
  partsRef.current = parts;
  const rows = useMemo<Row[]>(
    () =>
      [
        ...parts.map((row): Row & { at: number } => ({ kind: "cue", ...row, at: row.cue.startMs })),
        ...listedGaps(transcript.gaps).map((gap): Row & { at: number } => ({
          kind: "gap",
          gap,
          at: gap.fromMs,
        })),
        ...(microphonePausedAtMs === null
          ? []
          : [
              {
                kind: "microphone" as const,
                fromMs: microphonePausedAtMs,
                at: microphonePausedAtMs,
              },
            ]),
      ].sort((a, b) => a.at - b.at),
    [parts, transcript, microphonePausedAtMs],
  );
  const units = useMemo(() => transcriptUnits(transcript), [transcript]);
  const lines = useMemo<TranscriptLine[]>(
    () =>
      parts.flatMap(({ cue, part }) =>
        cue.speaker === null ? [] : [{ startMs: part.startMs, label: part.label }],
      ),
    [parts],
  );
  // Who speaks is said on a Meeting's saved Transcript, once the speaker pass has settled (#138).
  const nameable =
    meeting?.kind === "meeting" &&
    meeting.status === "stopped" &&
    state === "saved" &&
    !meeting.transcript?.separating &&
    document?.kind === "transcript"
      ? document
      : null;
  // A saved Transcript plays while its audio is kept; never while it records (#138).
  const playable =
    meeting?.status === "stopped" && state === "saved" && meeting.audio.kept && document !== null;
  const playerOpen = useTranscriptPlayer((player) => player.playback?.owner === owner);
  // In a Meeting's page, where the prototype has it; a Document's toolbar has no room for it.
  const { embedded } = useContext(ViewerFrameContext);
  const tipShown = useFeatureTip("transcript-word", meetingId ?? "", playable && embedded === true);
  useEffect(() => {
    const player = useTranscriptPlayer.getState();
    if (!playable && player.playback?.owner === owner) player.stop();
  }, [playable, owner]);
  useEffect(
    () => () => {
      const player = useTranscriptPlayer.getState();
      if (player.playback?.owner === owner) player.stop();
    },
    [owner],
  );

  /** The lines of the cited Units, by the time they start. */
  const citedLines = useCallback(() => {
    const cited = units.filter(
      (unit) =>
        target.pageFrom !== undefined &&
        unit.page >= target.pageFrom &&
        unit.page <= (target.pageTo ?? target.pageFrom),
    );
    const from = cited[0]?.label?.from;
    const to = cited.at(-1)?.label?.to;
    return [...(list.current?.querySelectorAll<HTMLElement>("[data-start]") ?? [])].filter(
      (line) => {
        const start = Number(line.dataset.start);
        return from !== undefined && to !== undefined && start >= from && start <= to;
      },
    );
  }, [units, target.pageFrom, target.pageTo]);
  // A cited page drawn to save it (#133): the cited lines.
  const citedArea = useCallback(() => {
    const lines = citedLines();
    return lines.length > 0 ? lines : null;
  }, [citedLines]);
  useCitedArea(units.length > 0, citedArea);

  // A part's own words, cited at its file's line, whose quote shows it as the part (#138).
  const addLine = useCallback(
    async ({ cue, part }: PartRow) => {
      if (!meetingId || !document) return;
      const unit = units.find(
        ({ label }) =>
          label?.from !== undefined &&
          label.to !== undefined &&
          cue.startMs >= label.from &&
          cue.startMs <= label.to,
      );
      setAdded(
        await addLineToNote({
          document,
          meetingId,
          cue: { ...cue, text: part.text },
          page: unit?.page ?? null,
        }),
      );
    },
    [document, meetingId, units],
  );
  useEffect(() => {
    if (added === null || added === "failed") return;
    const timer = setTimeout(() => setAdded(null), ADDED_SHOWN_MS);
    return () => clearTimeout(timer);
  }, [added]);
  useDismissOnEscape(added !== null && added !== "failed", () => setAdded(null));

  const durationMs = meeting?.recordedMs ?? 0;
  const playFrom = useCallback(
    (ms: number) => {
      if (!playable || !meetingId) return;
      void useTranscriptPlayer.getState().play(meetingId, ms, durationMs, owner);
    },
    [playable, meetingId, durationMs, owner],
  );
  const focusLine = useCallback((id: string) => {
    list.current?.querySelector<HTMLElement>(`[data-line="${CSS.escape(id)}"]`)?.focus();
  }, []);
  /** Where the caret is in the line, if it is in it. */
  const caretIn = (row: PartRow) =>
    caretRef.current?.line === row.id ? caretRef.current.at : null;
  /** Splits there unless it is the part's first word: who speaks the rest is asked at once. */
  const splitAt = useCallback(
    async (row: PartRow, at: number) => {
      const first = row.pieces.find((piece) => piece.word);
      if (!nameable || row.cue.speaker === null || !first || at <= first.at) return;
      const line = fileLineOf(row.cue);
      const next = withLineSplit(nameable.speakers, line, at, timeAt(row.cue, at));
      const made = partsOf(next, line).find((part) => part.at === at);
      if (!made) return;
      setCaret(null);
      const step = await useAppStore.getState().setTranscriptSpeakers(
        nameable.id,
        next,
        (t) => t("transcript.split.done"),
        (t) => t("undo.name.splitLine"),
      );
      if (!step) return;
      const id = lineId(made.startMs, made.endMs, row.cue.speaker);
      setRest({
        line: id,
        step,
        done: () => {
          setRest(null);
          focusLine(id);
        },
      });
    },
    [nameable, focusLine],
  );

  const activeRow = useCallback(
    () => partsRef.current.find((row) => row.id === activeId.current) ?? null,
    [],
  );
  const lend = useMemo(
    () => ({
      hasLine: () => meetingId !== null && activeRow() !== null,
      addLine: async () => {
        const row = activeRow();
        if (row) await addLine(row);
      },
      canChangeSpeaker: () => nameable !== null && activeRow()?.cue.speaker != null,
      changeSpeaker: () => {
        const row = activeRow();
        if (!row) return;
        speakerButtonOf(
          list.current?.querySelector(`[data-line="${CSS.escape(row.id)}"]`),
        )?.click();
      },
      canPlay: (): true | MessageKey =>
        playable
          ? true
          : meeting?.status === "stopped" && !meeting.audio.kept
            ? "meetings.command.noAudio"
            : "meetings.command.playAfterStop",
      play: () => {
        const row = activeRow();
        if (!row) return;
        const at = caretRef.current?.line === row.id ? caretRef.current.at : null;
        playFrom(at === null ? row.part.startMs : timeAt(row.cue, at));
      },
      playing: () => {
        const playback = useTranscriptPlayer.getState().playback;
        return playback?.owner === owner ? playback.playing : null;
      },
      togglePlayback: () => useTranscriptPlayer.getState().toggle(),
      canSplit: (): true | MessageKey => {
        const row = activeRow();
        if (!nameable) return "meetings.command.noSpeaker";
        const at = row && caretRef.current?.line === row.id ? caretRef.current.at : null;
        const first = row?.pieces.find((piece) => piece.word);
        return row && at !== null && first && at > first.at ? true : "meetings.command.noWord";
      },
      split: async () => {
        const row = activeRow();
        if (row && caretRef.current?.line === row.id) await splitAt(row, caretRef.current.at);
      },
    }),
    [activeRow, addLine, meeting, meetingId, nameable, owner, playFrom, playable, splitAt],
  );
  useHandle(transcriptHandle, lend);
  const firstId = parts[0]?.id;

  const onFocusRow = (row: PartRow) => {
    setActive(row.id);
    activeId.current = row.id;
    if (caretRef.current && caretRef.current.line !== row.id) setCaret(null);
  };

  const onWord = (row: PartRow, at: number) => {
    if (nameable) setCaret({ line: row.id, at });
    if (!playable) return;
    if (tipShown) closeTip("transcript-word");
    playFrom(timeAt(row.cue, at));
  };

  const onLineKey = (event: KeyboardEvent<HTMLElement>, row: PartRow) => {
    if (event.target !== event.currentTarget || event.nativeEvent.isComposing) return;
    if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
    const at = caretIn(row);
    const player = useTranscriptPlayer.getState();
    const playing = player.playback?.owner === owner;
    if (event.key === " " && playing) {
      event.preventDefault();
      void player.toggle();
    } else if (event.key === "Escape" && (playing || at !== null)) {
      event.preventDefault();
      if (playing) player.stop();
      else setCaret(null);
    } else if ((event.key === "ArrowRight" || event.key === "ArrowLeft") && nameable) {
      const direction = event.key === "ArrowRight" ? 1 : -1;
      const word = list.current && wordBeside(list.current, event.currentTarget, at, direction);
      const line = word?.closest<HTMLElement>("[data-line]");
      if (!word || !line?.dataset.line) return;
      event.preventDefault();
      // Focus first: a line focused drops a caret in another, and this one goes there after.
      if (line !== event.currentTarget) line.focus();
      setCaret({ line: line.dataset.line, at: Number(word.dataset.at) });
      word.scrollIntoView({ block: "nearest" });
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (at !== null) void splitAt(row, at);
      else void addLine(row);
    } else if (event.key === "F2" && nameable) {
      const button = speakerButtonOf(event.currentTarget);
      if (!button) return;
      event.preventDefault();
      button.click();
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      const next = lineBeside(event.currentTarget, event.key === "ArrowDown" ? "next" : "previous");
      if (!next) return;
      event.preventDefault();
      next.focus();
      next.scrollIntoView({ block: "nearest" });
    }
  };

  // Opened at a Citation: the quote washed in the cited lines; the view goes there,
  // once for each open request: lines arriving afterwards don't pull the view back.
  const shownRequest = useRef<string | null>(null);
  useLayoutEffect(() => {
    const body = list.current;
    const container = scroller.current;
    const request = `${target.request}:${target.quote}:${target.pageFrom}:${target.pageTo}`;
    if (!body || !container || !target.quote || shownRequest.current === request) return;
    if (units.length === 0) return;
    shownRequest.current = request;
    unmarkQuote(body);
    const lines = citedLines();
    let range: Range | undefined;
    const first = lines[0];
    const last = lines.at(-1);
    if (first && last) {
      range = body.ownerDocument.createRange();
      range.setStartBefore(first);
      range.setEndAfter(last);
    }
    const marks =
      target.pageFrom === undefined
        ? markQuote(textNodes(body), target.quote)
        : range && markQuote(textNodes(body, range), target.quote);
    setHighlighted((count) => (marks ? count + 1 : 0));
    const anchor = marks?.[0] ?? first ?? null;
    if (anchor) {
      following.current = false;
      const top =
        anchor.getBoundingClientRect().top -
        container.getBoundingClientRect().top +
        container.scrollTop;
      container.scrollTop = Math.max(0, top - container.clientHeight / 3);
    }
  }, [units, citedLines, target.request, target.quote, target.pageFrom, target.pageTo]);

  // New lines while live: followed, unless the User has scrolled up to read.
  // biome-ignore lint/correctness/useExhaustiveDependencies: placed again for each line
  useLayoutEffect(() => {
    const container = scroller.current;
    if (container && following.current) container.scrollTop = container.scrollHeight;
  }, [rows.length, partials]);

  useLayoutEffect(() => {
    const element = column.current;
    if (!element || !mark || highlighted === 0) {
      setMarkTop(null);
      return;
    }
    const place = () => {
      const first = element.querySelector("[data-quote-highlight]");
      setMarkTop(first ? markTopFor(first, element) : null);
      setMarkRoom(marginRoom(element));
    };
    place();
    const observer = new ResizeObserver(place);
    observer.observe(element);
    return () => observer.disconnect();
  }, [mark, highlighted]);

  const onScroll = () => {
    const container = scroller.current;
    if (!container) return;
    const end = container.scrollHeight - container.scrollTop - container.clientHeight <= FOLLOW_PX;
    following.current = end;
    setAtEnd(end);
  };

  const toEnd = () => {
    const container = scroller.current;
    if (!container) return;
    following.current = true;
    setAtEnd(true);
    container.scrollTop = container.scrollHeight;
  };

  return (
    <>
      <ViewerHeader>
        {live && state === "live" && (
          <span data-testid="transcript-live" className="transcript-live">
            <span aria-hidden="true" className="recording-dot" />
            {t("transcript.live")}
          </span>
        )}
        {live && state === "behind" && (
          <span data-testid="transcript-behind" className="transcript-live">
            {t("transcript.recording")}
          </span>
        )}
        {added && added !== "failed" && (
          <span role="status" data-testid="transcript-added" className="viewer-meta">
            {t(added === "added" ? "transcript.addToNote.added" : "transcript.addToNote.already")}
          </span>
        )}
        <span data-testid="transcript-count" className="viewer-meta">
          {t(transcript.cues.length === 1 ? "transcript.lines.one" : "transcript.lines.other", {
            count: transcript.cues.length,
          })}
        </span>
        {tipShown && (
          <Tip id="transcript-word" onClose={() => closeTip("transcript-word")}>
            {t("transcript.word.tip")}
          </Tip>
        )}
        {aside}
      </ViewerHeader>
      <div className="relative flex min-h-0 flex-1">
        <div
          ref={scroller}
          data-testid="viewer-transcript"
          data-quote-tone={quoteTone(target.citation)}
          onScroll={onScroll}
          className="viewer-backdrop viewer-text-backdrop min-h-0 min-w-0 flex-1 overflow-auto select-text"
        >
          <article
            data-player={playerOpen || undefined}
            className="viewer-page viewer-text-page transcript-page"
          >
            <div ref={column} className="relative">
              {rows.length === 0 && partials.length === 0 && (
                <p data-testid="transcript-empty" className="transcript-empty">
                  {t(live ? "transcript.waiting" : "transcript.none")}
                </p>
              )}
              {meetingId && (
                <p id={hintId} className="sr-only">
                  {t(nameable ? "transcript.line.hintSplit" : "transcript.line.hint")}
                </p>
              )}
              <ol
                ref={list}
                data-testid="transcript-lines"
                data-area-unit=""
                data-hours={(transcript.cues.at(-1)?.startMs ?? 0) >= 3_600_000 ? "" : undefined}
                className="transcript-lines"
              >
                {rows.map((row) =>
                  row.kind === "cue" ? (
                    <TranscriptRow
                      key={`c${row.id}`}
                      row={row}
                      meetingId={meetingId}
                      focusable={(active ?? firstId) === row.id}
                      hintId={hintId}
                      nameable={nameable}
                      lines={lines}
                      speakers={speakers}
                      playable={playable}
                      caretAt={caret?.line === row.id ? caret.at : null}
                      rest={rest?.line === row.id ? rest : null}
                      onFocus={onFocusRow}
                      onKeyDown={onLineKey}
                      onWord={onWord}
                      onAdd={(each) => void addLine(each)}
                    />
                  ) : row.kind === "microphone" ? (
                    <li
                      key="microphone-paused"
                      data-testid="transcript-mic-paused"
                      data-quote-skip=""
                      className="transcript-gap"
                    >
                      <span className="transcript-time">{paddedClockTime(row.fromMs)}</span>
                      <MetaLine
                        as="div"
                        parts={[
                          <span key="since">
                            <MicOffLineIcon className="mr-1.5 inline size-3.5 align-[-2px]" />
                            {t("meetings.mic.pausedSince", { time: paddedClockTime(row.fromMs) })}
                          </span>,
                          <LineAction
                            key="resume"
                            action={{
                              label: t("meetings.mic.resumeLine"),
                              testId: "transcript-mic-resume",
                              onClick: resumeMicrophone,
                            }}
                          />,
                        ]}
                      />
                    </li>
                  ) : (
                    <li
                      key={`g${row.gap.fromMs}-${row.gap.toMs}`}
                      data-testid="transcript-gap"
                      data-reason={row.gap.reason}
                      data-quote-skip=""
                      className="transcript-gap"
                    >
                      <span className="transcript-time">{paddedClockTime(row.gap.fromMs)}</span>
                      <span>
                        {row.gap.reason === "muted" ? (
                          <>
                            <MicOffLineIcon className="mr-1.5 inline size-3.5 align-[-2px]" />
                            {t("meetings.mic.pausedSpan", {
                              from: paddedClockTime(row.gap.fromMs),
                              to: paddedClockTime(row.gap.toMs),
                            })}
                          </>
                        ) : row.gap.toMs > row.gap.fromMs ? (
                          t("transcript.gap", {
                            duration: durationLabel(row.gap.toMs - row.gap.fromMs, t),
                            reason: t(GAP_REASONS[row.gap.reason]),
                          })
                        ) : (
                          t(GAP_REASONS[row.gap.reason])
                        )}
                      </span>
                    </li>
                  ),
                )}
                {partials.map((partial) => (
                  <li
                    key={`p${partial.startMs}:${partial.speaker ?? ""}`}
                    data-testid="transcript-partial"
                    data-quote-skip=""
                    aria-live="polite"
                    className="transcript-line transcript-line--partial"
                  >
                    <span className="transcript-time">{paddedClockTime(partial.startMs)}</span>
                    <div className="min-w-0">
                      {partial.speaker && (
                        <p data-testid="transcript-speaker" className="transcript-speaker">
                          {speakerName(partial.speaker, t)}
                        </p>
                      )}
                      <p className="transcript-text">{partial.text}</p>
                    </div>
                  </li>
                ))}
              </ol>
              {mark && markTop !== null && (
                <CitationMark
                  mark={mark}
                  room={markRoom}
                  style={{ top: markTop, left: "calc(100% + 12px)" }}
                />
              )}
            </div>
          </article>
        </div>
        {live && !atEnd && (
          <button
            type="button"
            data-testid="transcript-follow"
            onClick={toEnd}
            className="transcript-follow"
          >
            {t("transcript.follow")}
          </button>
        )}
        <TranscriptPlayerBar owner={owner} />
      </div>
    </>
  );
}
