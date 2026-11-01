const formal = (paragraph: string) =>
  paragraph
    .replace(/\bIt['’]s\b/g, "It is")
    .replace(/\bdon['’]t\b/g, "do not")
    .replace(/\ba lot of\b/g, "a great many")
    .replace(/\bbig\b/g, "considerable");

/**
 * Replies the guards on an applied edit are for (#880), or null: "make the
 * second paragraph more formal" gives only that paragraph back, as Claude
 * Haiku 5.5 did with the whole note selected; "add a closing paragraph" adds
 * a Block after the passage; "delete the second paragraph" quotes it between <removed> and
 * </removed> (#2180); "make it longer" adds a sentence to each
 * paragraph, and "… to be clearer" writes two new paragraphs in place of the passage.
 */
export function appliedEditReply(passage: string, asked: string): string | null {
  const paragraphs = passage.split(/\n\n+/);
  if (/second paragraph more formal|第二段.*正式/iu.test(asked)) return formal(paragraphs[1] ?? "");
  if (/^delete the second paragraph|^删除第二段/iu.test(asked)) {
    return [paragraphs[0], `<removed>${paragraphs[1]}</removed>`, ...paragraphs.slice(2)].join(
      "\n\n",
    );
  }
  if (/add a closing paragraph|加一段结尾/iu.test(asked))
    return `${passage}\n\nThat is all for now.`;
  if (/to be clearer|写清楚/iu.test(asked)) {
    return "Gulls wheel over the quay at dawn.\n\nBoats rest on the mud at low water.";
  }
  if (/\bmake it longer\b|长一点|更长/iu.test(asked)) {
    return paragraphs
      .map((each) => (each.startsWith("#") ? each : `${each} It says more.`))
      .join("\n\n");
  }
  if (/haiku|俳句/iu.test(asked)) {
    return "Gulls wheel, crying\n\nsalt wind on stone\n\nnight falls soft";
  }
  return null;
}

/** Asked of the assistant, "replace X with Y" is an edit of the Mind, with edit_mind. */
export const ASSISTANT_REPLACES = /^replace\s+.+\s+with\s+/i;
