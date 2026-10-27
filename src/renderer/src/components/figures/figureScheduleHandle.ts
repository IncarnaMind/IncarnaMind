import type { FigureSchedule } from "../../../../core/api";

/**
 * The Figure schedule the User works in, for ⌘K: its rows, and what its rows' menus do to the
 * figures chosen. Set while a schedule is open; the last one opened holds it.
 */
export interface FigureScheduleHandle {
  schedule: FigureSchedule;
  keep(ids: string[]): void;
  checkAgain(ids: string[]): void;
}

export const figureScheduleHandle: { current: FigureScheduleHandle | null } = { current: null };
