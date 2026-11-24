/**
 * Characters that draw nothing, or move the text around them: controls, zero-width and other
 * format characters, and the marks that turn text right to left. A value could hide or reorder
 * what it does with them.
 */
const UNSEEN = /(?![\n\t])\p{Cc}|\p{Cf}|\p{Variation_Selector}|[\u115F\u1160\u3164\uFFA0]/gu;

/** A value with each character that draws nothing shown as its code, as ⟨U+202E⟩. */
export const visible = (value: string) =>
  value.replace(
    UNSEEN,
    (unseen) => `⟨U+${(unseen.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0")}⟩`,
  );
