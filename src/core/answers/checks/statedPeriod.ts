function calendarDate(value: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value ? date : null;
}

/** On the injected UTC Check day, a begun period is recent through its twelve-month anniversary. */
export function inCurrentPeriodWindow(
  period: { start: string; end: string },
  checkedAt: Date,
): boolean {
  const start = calendarDate(period.start);
  const end = calendarDate(period.end);
  if (!start || !end || start > end || !Number.isFinite(checkedAt.getTime())) return false;
  const day = new Date(checkedAt);
  day.setUTCHours(0, 0, 0, 0);
  if (start > day) return false;
  const anniversary = new Date(end);
  anniversary.setUTCDate(1);
  anniversary.setUTCFullYear(end.getUTCFullYear() + 1);
  anniversary.setUTCMonth(end.getUTCMonth() + 1);
  anniversary.setUTCDate(0);
  anniversary.setUTCDate(Math.min(end.getUTCDate(), anniversary.getUTCDate()));
  return day <= anniversary;
}
