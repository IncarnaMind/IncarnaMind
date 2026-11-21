import type { CalendarOffer } from "../api";

export interface CalendarReminderEvent {
  id: string;
  ids: readonly string[];
  occurrenceKey: string;
  title: string;
  seen: boolean;
  startsAt: string;
  endsAt: string;
}

export interface CalendarOffersOptions {
  /** A Meeting records or is paused: nothing is offered then. */
  busy(): boolean;
  calendarAllowed(): boolean;
  calendarEvents(): readonly CalendarReminderEvent[];
  markCalendarReminderSeen(ids: readonly string[], startsAt: string): void;
  now(): Date;
  newId(): string;
}

const LEAD_MS = 60_000;
const GRACE_MS = 5 * 60_000;
const expiresAt = (event: CalendarReminderEvent) =>
  Math.min(Date.parse(event.endsAt), Date.parse(event.startsAt) + GRACE_MS);

export function createCalendarOffers(options: CalendarOffersOptions, wake: () => void) {
  let current: { key: string; shownAt: number; offer: CalendarOffer } | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let wakeAt = Infinity;

  function schedule(at: number, now: number) {
    if (at === wakeAt) return;
    if (timer) clearTimeout(timer);
    timer = null;
    wakeAt = at;
    if (!Number.isFinite(at)) return;
    timer = setTimeout(
      () => {
        timer = null;
        wakeAt = Infinity;
        wake();
      },
      Math.min(at - now, 2_147_483_647),
    );
    timer.unref?.();
  }

  function refresh() {
    if (!options.calendarAllowed() || options.busy()) {
      current = null;
      schedule(Infinity, 0);
      return;
    }

    const now = options.now().getTime();
    const events = options.calendarEvents();
    const active = events.find(
      (event) =>
        current !== null &&
        event.startsAt === current.offer.startsAt &&
        event.occurrenceKey === current.key &&
        now >= Date.parse(event.startsAt) - LEAD_MS &&
        now < expiresAt(event),
    );
    if (active && current) {
      if (!active.seen) options.markCalendarReminderSeen(active.ids, active.startsAt);
      current = {
        ...current,
        offer: { ...current.offer, eventId: active.id, title: active.title },
      };
    } else {
      current = null;
    }

    let next = Infinity;
    let upcoming: CalendarReminderEvent | undefined;
    let waiting = false;
    for (const event of events) {
      const start = Date.parse(event.startsAt);
      const due = start - LEAD_MS;
      if (now < due) {
        next = Math.min(next, due);
        continue;
      }
      if (now >= start || event.seen || event === active) continue;
      // When several invites are already due together, keep the first selectable until its start.
      if (current && due <= current.shownAt && now < Date.parse(current.offer.startsAt)) {
        next = Math.min(next, Date.parse(current.offer.startsAt));
        continue;
      }
      if (upcoming) waiting = true;
      else upcoming = event;
    }
    if (upcoming) {
      options.markCalendarReminderSeen(upcoming.ids, upcoming.startsAt);
      current = {
        key: upcoming.occurrenceKey,
        shownAt: now,
        offer: {
          kind: "calendar",
          id: options.newId(),
          eventId: upcoming.id,
          title: upcoming.title,
          startsAt: upcoming.startsAt,
        },
      };
      next = Math.min(next, waiting ? Date.parse(upcoming.startsAt) : expiresAt(upcoming));
    } else if (active) {
      next = Math.min(next, expiresAt(active));
    }
    schedule(next, now);
  }

  return {
    get: () => current?.offer ?? null,
    dismiss() {
      current = null;
    },
    refresh,
    close() {
      current = null;
      schedule(Infinity, 0);
    },
  };
}
