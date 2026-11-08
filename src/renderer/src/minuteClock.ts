import { useEffect, useState } from "react";

const MINUTE_MS = 60_000;

/** The time now, read again every minute: for words that change with it, as "today" at midnight. */
export function useMinuteClock(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), MINUTE_MS);
    return () => clearInterval(timer);
  }, []);
  return now;
}
