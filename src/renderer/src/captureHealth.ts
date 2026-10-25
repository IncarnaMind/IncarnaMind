import type {
  AudioLossCause,
  CaptureHealthEvent,
  EngineSwitchReason,
  Meeting,
  TranscriptionEngine,
} from "../../core/api";
import type { MessageKey, MessageParams } from "../../shared/i18n";
import { durationLabel } from "./meetingTime";

type Translate = (key: MessageKey, params?: MessageParams) => string;

/** A line of a Meeting's recording details: where in the Meeting, if anywhere, and what. */
export interface CaptureLine {
  key: string;
  atMs: number | null;
  text: string;
}

const CAUSES: Record<AudioLossCause, MessageKey> = {
  full: "meetings.health.cause.full",
  denied: "meetings.health.cause.denied",
  error: "meetings.health.cause.error",
  closed: "meetings.health.cause.closed",
  stalled: "meetings.health.cause.stalled",
};

/** Why transcription left an engine, by the engine it left. */
const REASONS: Record<TranscriptionEngine, Record<EngineSwitchReason, MessageKey>> = {
  local: {
    behind: "meetings.health.reason.localBehind",
    failed: "meetings.health.reason.localFailed",
    user: "meetings.health.reason.user",
    cap: "meetings.health.reason.cap",
  },
  cloud: {
    behind: "meetings.health.reason.cloudBehind",
    failed: "meetings.health.reason.cloudFailed",
    user: "meetings.health.reason.user",
    cap: "meetings.health.reason.cap",
  },
};

/** Audio lost because a part couldn't be saved, which the User can do something about. */
const SAVE_CAUSES: ReadonlySet<AudioLossCause> = new Set(["full", "denied", "error"]);

/** A stretch in words, never "0 s". */
const lasting = (ms: number, t: Translate) => durationLabel(Math.max(ms, 1000), t);

/** How much faster than the Meeting it was transcribed: "2.4", "0.5". */
const speedOf = (realTimeFactor: number) =>
  String(Number(Math.min(99, 1 / Math.max(realTimeFactor, 0.01)).toFixed(1)));

function eventText(event: CaptureHealthEvent, t: Translate): string {
  switch (event.kind) {
    case "audioLost":
      return t(
        event.source === "microphone"
          ? "meetings.health.lost.microphone"
          : "meetings.health.lost.system",
        { duration: lasting(event.durationMs, t), cause: t(CAUSES[event.cause]) },
      );
    case "audioRecovered":
      return t("meetings.health.recovered", { duration: lasting(event.durationMs, t) });
    case "restarted":
      return event.gapMs > 0
        ? t("meetings.health.restarted", { duration: lasting(event.gapMs, t) })
        : t("meetings.health.restartedNoGap");
    case "behind":
      return t("meetings.health.behind");
    case "notTranscribed":
      return t("meetings.health.notTranscribed", { duration: lasting(event.durationMs, t) });
    case "switched":
      return t(event.to === "cloud" ? "meetings.health.toCloud" : "meetings.health.toLocal", {
        reason: t(REASONS[event.from][event.reason]),
      });
  }
}

/**
 * How a Meeting's capture went (#161), as its recording details say it: how
 * fast this computer transcribed it, then what happened, in the order it
 * did, and whether any audio was lost.
 */
export function captureLines(meeting: Meeting, t: Translate): CaptureLine[] {
  const { health } = meeting;
  const lines: CaptureLine[] = [];
  if (meeting.transcript) {
    const factor = health.realTimeFactor;
    lines.push({
      key: "speed",
      atMs: null,
      text:
        factor === null
          ? t("meetings.health.speedUnknown")
          : t(health.keepsUp ? "meetings.health.speed" : "meetings.health.speedSlow", {
              speed: speedOf(factor),
            }),
    });
  }
  health.events.forEach((event, index) => {
    lines.push({ key: `${event.kind}-${index}`, atMs: event.atMs, text: eventText(event, t) });
  });
  if (!health.events.some((event) => event.kind === "audioLost")) {
    lines.push({ key: "no-loss", atMs: null, text: t("meetings.health.noLoss") });
  }
  return lines;
}

/**
 * How much of the Meeting has audio that couldn't be saved, once the line
 * saying so while it happens has gone: what its problem line says. Both
 * sources lost at once count once.
 */
export function unsavedAudioMs(meeting: Meeting): number {
  if (meeting.saveError) return 0;
  const lost = meeting.health.events
    .flatMap((event) =>
      event.kind === "audioLost" && SAVE_CAUSES.has(event.cause)
        ? [{ from: event.atMs, to: event.atMs + event.durationMs }]
        : [],
    )
    .sort((a, b) => a.from - b.from);
  let total = 0;
  let end = Number.NEGATIVE_INFINITY;
  for (const { from, to } of lost) {
    total += Math.max(0, to - Math.max(from, end));
    end = Math.max(end, to);
  }
  return total;
}
