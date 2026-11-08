// pdf.js waits for its worker and for the file's bytes with no limit of its own (#2828).
const OPEN_LIMIT_MS = 15_000;
let limitMs = OPEN_LIMIT_MS;

/** How long a Document may take to open before the viewer stops saying it is opening; test builds shorten it. */
export const setViewerOpenLimitMs = (ms: number): void => {
  limitMs = ms;
};

export const viewerOpenLimitMs = (): number => limitMs;
