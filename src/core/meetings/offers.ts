/**
 * Offers to take notes in an upcoming calendar meeting (#189) or a detected call (#208).
 * A scheduled reminder takes precedence while both are eligible. Only Take notes records.
 * A Meeting taken for a detected call stops 30 seconds after its app releases the microphone
 * unless the User keeps recording or the app takes it back.
 */
import type { CallWatcher, Logger } from "../adapters";
import type {
  CallEnding,
  CallOffer,
  CallWatchProblem,
  DeviceSettings,
  MeetingOffer,
  MeetingOffers,
} from "../api";
import { NotFoundError } from "../errors";
import { type CalendarOffersOptions, createCalendarOffers } from "./calendarOffers";

/** A call app that lets go of the microphone and takes it back within this is still in the same call (a device switch, a rejoin). */
export const SAME_CALL_MS = 10_000;
/** How long after the call app lets go of the microphone its Meeting stops: the line "Stopping in 30 seconds". */
export const STOP_AFTER_CALL_MS = 30_000;

/**
 * Whether an offer to take notes may show, by the User's switches in Settings › General (#189):
 * the calendar's before a calendar meeting (#207), a call's when `app` took the microphone.
 * Offers wait for Meetings to be in use: a first recording made on this device.
 */
export function offerAllowed(
  device: Pick<
    DeviceSettings,
    "meetingNoticeAccepted" | "calendarOffers" | "callOffers" | "callOffersOff"
  >,
  offer: { kind: "calendar" } | { kind: "call"; app: string },
): boolean {
  if (!device.meetingNoticeAccepted) return false;
  if (offer.kind === "calendar") return device.calendarOffers;
  return device.callOffers && !device.callOffersOff.includes(offer.app);
}

export interface MeetingOffersOptions extends CalendarOffersOptions {
  watcher: CallWatcher | undefined;
  /** Whether call offers are wanted at all: watching stops while they aren't. */
  watching(): boolean;
  /** Whether a call in `app` may be offered now (`offerAllowed`). */
  allowed(app: string): boolean;
  /** Whether the Meeting records or is paused. */
  live(meetingId: string): boolean;
  /** Records the call in a new Note, opened in the main window; its Meeting's id. */
  record(app: string): string;
  recordCalendar(eventId: string): TakenMeetingOffer;
  stop(meetingId: string): void;
  changed(offers: MeetingOffers): void;
  log: Logger;
}

export interface TakenMeetingOffer {
  meetingId: string;
  joinUrl: string | null;
}

export interface MeetingOffersControl {
  get(): MeetingOffers;
  take(offerId: string): TakenMeetingOffer;
  decline(offerId: string, always: boolean): MeetingOffer | null;
  keepRecording(meetingId: string): void;
  /** The switches or Meetings changed: starts or stops watching, and takes back what no longer holds. */
  refresh(): void;
  close(): void;
}

export function createMeetingOffers(options: MeetingOffersOptions): MeetingOffersControl {
  const { log } = options;
  let stopWatching: (() => void) | null = null;
  let problem: CallWatchProblem | null = null;
  let using = new Set<string>();
  let call: CallOffer | null = null;
  let taking = false;
  let closed = false;
  const calendar = createCalendarOffers(options, () => refresh());

  let ending: (CallEnding & { timer: ReturnType<typeof setTimeout> }) | null = null;
  /** Meetings taken from an offer, by id: the call app each records. */
  const taken = new Map<string, string>();
  /** Apps that let go of the microphone, until the call is over (`SAME_CALL_MS`). */
  const letGo = new Map<string, { timer: ReturnType<typeof setTimeout>; exact: boolean }>();
  /** Apps whose call the User declined; offered again once that call is over. */
  const declined = new Set<string>();

  const state = (): MeetingOffers => ({
    offer: taking ? null : (calendar.get() ?? call),
    ending: ending && { meetingId: ending.meetingId, app: ending.app, stopsAt: ending.stopsAt },
    problem,
  });
  let published = JSON.stringify(state());
  const changed = () => {
    const snapshot = state();
    const serialized = JSON.stringify(snapshot);
    if (published === serialized) return;
    published = serialized;
    options.changed(snapshot);
  };

  const cancelEnding = () => {
    if (!ending) return;
    clearTimeout(ending.timer);
    ending = null;
  };

  const callOver = (app: string) => {
    letGo.delete(app);
    declined.delete(app);
    if (call?.app === app) {
      call = null;
      changed();
    }
  };

  const offerCall = (app: string) => {
    if (taking || call || declined.has(app)) return;
    if ([...taken.values()].includes(app)) return;
    if (options.busy() || !options.allowed(app)) return;
    call = { kind: "call", id: options.newId(), app, at: options.now().toISOString() };
    log.info("meeting.offered");
  };

  const revealCall = () => {
    if (call && !using.has(call.app)) call = null;
    for (const app of using) offerCall(app);
  };

  const tookMicrophone = (app: string) => {
    const waiting = letGo.get(app);
    if (waiting) {
      clearTimeout(waiting.timer);
      letGo.delete(app);
    }
    if (ending?.app === app) {
      cancelEnding();
      log.info("meeting.callBack");
      changed();
    }
    offerCall(app);
    changed();
  };

  const letGoOfMicrophone = (app: string, exact: boolean) => {
    letGo.set(app, { timer: setTimeout(() => callOver(app), SAME_CALL_MS), exact });
    // Only a watcher that says when an app lets go may stop a recording.
    if (ending || !exact || options.watcher?.endRecordingOnRelease === false) return;
    const meetingId = [...taken].find(
      ([id, takenApp]) => takenApp === app && options.live(id),
    )?.[0];
    if (!meetingId) return;
    const stopsAt = new Date(options.now().getTime() + STOP_AFTER_CALL_MS).toISOString();
    const timer = setTimeout(() => {
      ending = null;
      taken.delete(meetingId);
      try {
        if (options.live(meetingId)) options.stop(meetingId);
        log.info("meeting.stoppedAfterCall");
      } catch (error) {
        log.error("meeting.stopAfterCallFailed", {
          message: error instanceof Error ? error.message : String(error),
        });
      }
      changed();
    }, STOP_AFTER_CALL_MS);
    ending = { meetingId, app, stopsAt, timer };
    log.info("meeting.callEnded");
    changed();
  };

  const heard = (apps: readonly string[], exact: boolean) => {
    if (closed) return;
    const now = new Set(apps);
    const before = using;
    using = now;
    for (const app of now) if (!before.has(app)) tookMicrophone(app);
    for (const app of before) if (!now.has(app)) letGoOfMicrophone(app, exact);
  };

  const stopWatchingCalls = () => {
    stopWatching?.();
    stopWatching = null;
    using = new Set();
    for (const waiting of letGo.values()) clearTimeout(waiting.timer);
    letGo.clear();
    declined.clear();
    call = null;
    cancelEnding();
  };

  function refresh() {
    if (closed) return;
    const wanted = options.watching() && options.watcher !== undefined;
    const previousCalendar = calendar.get();
    if (!taking) calendar.refresh();
    if (previousCalendar && !calendar.get()) revealCall();
    if (call && !previousCalendar && calendar.get()) call = { ...call, id: options.newId() };
    if (!wanted && stopWatching) stopWatchingCalls();
    if (!wanted) problem = null;
    if (wanted && !stopWatching && options.watcher) {
      problem = null;
      stopWatching = options.watcher.watch({
        apps: heard,
        problem: (found) => {
          if (closed) return;
          log.warn("meeting.callWatchProblem", { problem: found });
          problem = found;
          changed();
        },
      });
    }
    if (call && (options.busy() || !options.allowed(call.app))) call = null;
    for (const id of taken.keys()) {
      if (options.live(id)) continue;
      taken.delete(id);
      if (ending?.meetingId === id) cancelEnding();
    }
    changed();
  }

  return {
    get: state,
    take(offerId) {
      refresh();
      const offer = state().offer;
      if (
        !offer ||
        offer.id !== offerId ||
        (offer.kind === "call" && letGo.get(offer.app)?.exact)
      ) {
        throw new NotFoundError({ key: "error.meetingOffer.gone" });
      }
      taking = true;
      call = null;
      changed();
      try {
        const result =
          offer.kind === "calendar"
            ? options.recordCalendar(offer.eventId)
            : { meetingId: options.record(offer.app), joinUrl: null };
        if (offer.kind === "calendar") calendar.dismiss();
        else taken.set(result.meetingId, offer.app);
        log.info("meeting.offerTaken");
        return result;
      } finally {
        taking = false;
        refresh();
      }
    },
    decline(offerId, always) {
      refresh();
      const offer = state().offer;
      if (!offer || offer.id !== offerId) return null;
      if (offer.kind === "calendar") {
        calendar.dismiss();
        revealCall();
        refresh();
      } else {
        declined.add(offer.app);
        call = null;
      }
      log.info("meeting.offerDeclined", { always });
      changed();
      return offer;
    },
    keepRecording(meetingId) {
      if (ending?.meetingId !== meetingId) return;
      cancelEnding();
      changed();
    },
    refresh,
    close() {
      closed = true;
      calendar.close();
      stopWatchingCalls();
    },
  };
}
