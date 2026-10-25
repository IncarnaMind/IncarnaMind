const AFTER_STOP = /[。！？）]$/;

/** The dot after a meta line's part: after full-width punctuation, with no space before it, as Chinese sets it. */
export const dotAfter = (part: string) => (AFTER_STOP.test(part) ? "· " : " · ");
