import { type Block, NO_MARKS } from "./mindText";

/**
 * A Note's Blocks with each of its tabs (#3414) as a top-level section, as a file lays them out:
 * the tab's title a Heading 1, every section after the first on a new page. `untitled` names a tab
 * that has no title, by its number from 1. A heading 1 the Note opens with is its title, above
 * the first section, as a file's title is above its parts. A Note without tabs is as it is.
 */
export function withTabSections(
  blocks: readonly Block[],
  untitled: (number: number) => string,
): Block[] {
  if (!blocks.some((block) => block.kind === "tab")) return [...blocks];
  const rest = [...blocks];
  const out: Block[] = [];
  const opening = rest[0]?.kind === "tab" ? 1 : 0;
  const title = rest[opening];
  if (title?.kind === "heading" && title.level === 1) {
    out.push(title);
    rest.splice(opening, 1);
  }
  // Numbered as the panel numbers them: the Blocks before the first tab Block are tab 1, even
  // when the title was all they held.
  let number = opening === 0 ? 1 : 0;
  let sections = 0;
  const section = (name: string) => {
    if (sections > 0) out.push({ kind: "paragraph", content: [{ kind: "pageBreak" }] });
    sections++;
    out.push(tabHeading(name || untitled(number)));
  };
  if (rest[0] && rest[0].kind !== "tab") section("");
  for (const block of rest) {
    if (block.kind !== "tab") out.push(block);
    else {
      number++;
      section(block.title);
    }
  }
  return out;
}

/** A tab's title as the heading of its section: what a writer draws for a tab it meets. */
export const tabHeading = (title: string): Block => ({
  kind: "heading",
  level: 1,
  content: title ? [{ kind: "text", text: title, marks: NO_MARKS }] : [],
});
