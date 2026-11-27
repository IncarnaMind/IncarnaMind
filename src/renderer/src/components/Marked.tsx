import type { ReactNode } from "react";
import type { TextRange } from "../../../core/api";

/** Text with the words found in it in bold. */
export function Marked({ text, ranges }: { text: string; ranges: readonly TextRange[] }) {
  const parts: ReactNode[] = [];
  let at = 0;
  for (const range of ranges) {
    if (range.start < at) continue;
    if (range.start > at) parts.push(text.slice(at, range.start));
    parts.push(
      <b key={range.start} className="font-semibold text-ink">
        {text.slice(range.start, range.end)}
      </b>,
    );
    at = range.end;
  }
  parts.push(text.slice(at));
  return <>{parts}</>;
}
