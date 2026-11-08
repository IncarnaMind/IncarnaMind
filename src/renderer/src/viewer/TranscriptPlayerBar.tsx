import { paddedClockTime } from "../../../shared/clock";
import { CloseLineIcon, PauseLineIcon, ResumeLineIcon } from "../components/lineIcons";
import { ProblemMark } from "../components/ProblemLine";
import { describeError } from "../errors";
import { useT } from "../i18n";
import { useTranscriptPlayer } from "../transcriptPlayer";

/**
 * The player at the foot of a Transcript while its Meeting's audio plays from a clicked word
 * (#138), as the prototype has it: Pause or Play, where it is of how long, and Space to pause.
 * Its keys reach it from the Transcript's lines; ✕ or Esc closes it.
 */
export function TranscriptPlayerBar({ owner }: { owner: string }) {
  const t = useT();
  const playback = useTranscriptPlayer((state) =>
    state.playback?.owner === owner ? state.playback : null,
  );
  if (!playback) return null;
  const { toggle, stop } = useTranscriptPlayer.getState();
  const { positionMs, durationMs, playing, failure } = playback;
  const wording = failure === null ? null : describeError(failure).wording;
  return (
    <fieldset
      aria-label={t("transcript.player")}
      data-testid="transcript-player"
      data-playing={playing || undefined}
      data-quote-skip=""
      className="transcript-player"
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        stop();
      }}
    >
      <button
        type="button"
        data-testid="transcript-player-toggle"
        aria-label={t(playing ? "transcript.player.pause" : "transcript.player.play")}
        title={t(playing ? "transcript.player.pause" : "transcript.player.play")}
        disabled={failure !== null}
        onClick={() => void toggle()}
        className="transcript-player-toggle"
      >
        {playing ? (
          <PauseLineIcon aria-hidden="true" className="size-3.5" />
        ) : (
          <ResumeLineIcon aria-hidden="true" className="size-3.5" />
        )}
      </button>
      {failure === null ? (
        <>
          <span data-testid="transcript-player-time" className="tabular-nums whitespace-nowrap">
            {paddedClockTime(positionMs)} / {paddedClockTime(durationMs)}
          </span>
          <span aria-hidden="true" className="transcript-player-track">
            <span
              style={{ transform: `scaleX(${durationMs > 0 ? positionMs / durationMs : 0})` }}
            />
          </span>
          <span className="text-[12px] whitespace-nowrap text-ink-meta">
            {t("transcript.player.spaceToPause")}
          </span>
        </>
      ) : (
        <span role="alert" data-testid="transcript-player-failed" className="min-w-0 flex-1">
          <ProblemMark />
          {wording ? t(wording.key, wording.values) : t("transcript.player.failed")}
        </span>
      )}
      <button
        type="button"
        data-testid="transcript-player-close"
        aria-label={t("transcript.player.close")}
        title={t("transcript.player.close")}
        onClick={stop}
        className="inline-flex size-6 shrink-0 items-center justify-center rounded-md hover:bg-hover hover:text-ink"
      >
        <CloseLineIcon aria-hidden="true" className="size-3" />
      </button>
    </fieldset>
  );
}
