export interface DocumentPages {
  from: number;
  to: number;
  limited: boolean;
}

/** One page or a safe page range, capped at three pages for one Document read. */
export function readDocumentPages(pages: string): DocumentPages | null {
  const match = /^(\d+)(?:\s*[-–]\s*(\d+))?$/.exec(pages.trim());
  if (!match) return null;
  const from = Number(match[1]);
  const requestedTo = Number(match[2] ?? match[1]);
  if (
    !Number.isSafeInteger(from) ||
    !Number.isSafeInteger(requestedTo) ||
    from < 1 ||
    requestedTo < from
  ) {
    return null;
  }
  const to = Math.min(requestedTo, from + 2);
  return { from, to, limited: to < requestedTo };
}

export const formatDocumentPages = ({ from, to }: DocumentPages): string =>
  from === to ? `${from}` : `${from}–${to}`;
