/**
 * Citations in what a Word export writes into an imported document (#105),
 * in the Mind's citation style, as the native export writes them (../citations):
 * every paragraph written and every new Block is styled in one pass, in
 * document order, so numbers and the Bibliography come out as they would in
 * a new document. Numbered makes each Citation a footnote right after the
 * word, or, when the User chose a list at the end, a `[1]` in the text; a style
 * writes each cluster (Citations side by side) in the text or as a note.
 */
import type { ResolvedCitationStyle } from "../../../shared/citationStyles";
import type { SourceContext } from "../../../shared/sources";
import type { CitationFormatRequest, FormattedCitations } from "../../api";
import { type Block, type Inline, NO_MARKS as PLAIN } from "../../mindText";
import { addSources, changeKey, listCitations, styleCitations } from "../citations";
import { special, type Token } from "./paragraph";

/** Something the export writes: a paragraph's text, or a new Block's. */
export interface Written {
  tokens?: Token[];
  blocks?: Block[];
}

export interface CitationOptions {
  style: ResolvedCitationStyle;
  /** Whether a Numbered Mind shows its Bibliography. */
  bibliography: boolean;
  /** Citations as `[1]` and a list at the end, instead of footnotes (#1600). */
  listed: boolean;
  heading: string;
  sources: SourceContext;
  format(request: CitationFormatRequest): Promise<FormattedCitations>;
  /** The mark after an entry too thin to cite (`ExportLabels.needsDetails`). */
  needsDetails: string;
  /** The mark after a Location whose quote wasn't found (`ExportLabels.unverified`). */
  unverified: string;
}

const isCitation = (token: Token | undefined) =>
  token?.kind === "special" && token.inline?.kind === "citation";
/** Citations a change still waiting does the same to (#107), which can be one cluster. */
const alike = (a: Token | undefined, b: Token | undefined) =>
  changeKey(a?.inline ?? undefined) === changeKey(b?.inline ?? undefined);
const isBlank = (token: Token | undefined) =>
  token?.kind === "char" && token.char !== "\n" && /^\s$/u.test(token.char);

/** Drops the spaces right before `at`, as the editor's space before a footnote's number goes in print. */
function trimBefore(tokens: Token[], at: number): number {
  let from = at;
  while (
    from > 0 &&
    tokens[from - 1]?.kind === "char" &&
    /^[ \t\u00a0]$/.test(tokens[from - 1]?.char ?? "")
  ) {
    from--;
  }
  tokens.splice(from, at - from);
  return from;
}

/** Where each cluster is: Citations with only spaces between them, as ../citations finds them. */
function clustersOf(tokens: readonly Token[]): { start: number; end: number }[] {
  const found: { start: number; end: number }[] = [];
  for (let index = 0; index < tokens.length; ) {
    if (!isCitation(tokens[index])) {
      index++;
      continue;
    }
    let end = index + 1;
    const first = tokens[index];
    for (;;) {
      if (isCitation(tokens[end]) && alike(tokens[end], first)) {
        end++;
        continue;
      }
      let blank = end;
      while (isBlank(tokens[blank])) blank++;
      if (blank > end && isCitation(tokens[blank]) && alike(tokens[blank], first)) end = blank + 1;
      else break;
    }
    found.push({ start: index, end });
    index = end;
  }
  return found;
}

/** A paragraph's tokens as a Block the citation styles read: text, its Citations, and what isn't text marked. */
function asBlock(tokens: readonly Token[]): Block {
  const content: Inline[] = [];
  for (const token of tokens) {
    if (token.kind === "special" && token.inline) {
      content.push(token.inline);
      continue;
    }
    const text = token.kind === "char" ? token.char : token.kind === "break" ? "\n" : "￼";
    const last = content.at(-1);
    if (last?.kind === "text") last.text += text;
    else content.push({ kind: "text", text, marks: { ...PLAIN } });
  }
  return { kind: "paragraph", content };
}

/**
 * Writes the Citations of everything written in the Mind's style, in place,
 * and returns the Bibliography to add at the end of the document (none for a
 * Numbered Mind that doesn't show one).
 */
export async function styleWritten(
  written: readonly Written[],
  options: CitationOptions,
): Promise<Block[]> {
  const numbered = options.style.form === "numbered" && !options.listed;
  for (const each of written) {
    const { tokens } = each;
    if (!tokens) continue;
    for (let index = 0; index < tokens.length; index++) {
      const token = tokens[index];
      if (token?.kind === "special" && token.inline?.kind === "footnote")
        index = trimBefore(tokens, index);
      else if (numbered && isCitation(token)) index = trimBefore(tokens, index);
    }
  }

  const blocks: Block[] = written.flatMap((each) =>
    each.tokens ? [asBlock(each.tokens)] : (each.blocks ?? []),
  );
  let styled: Block[];
  if (numbered) {
    if (!options.bibliography) return [];
    styled = addSources(blocks, options.sources, options.heading);
    return styled.length > blocks.length ? styled.slice(blocks.length) : [];
  }
  styled = options.listed
    ? listCitations(blocks, options.sources, options.heading, options.unverified)
    : await styleCitations(blocks, options.style, options.format, options.needsDetails);

  let at = 0;
  for (const each of written) {
    if (!each.tokens) {
      const count = each.blocks?.length ?? 0;
      each.blocks = styled.slice(at, at + count);
      at += count;
      continue;
    }
    const block = styled[at++];
    const cites =
      block?.kind === "paragraph"
        ? block.content.filter(
            (inline): inline is Extract<Inline, { kind: "cite" }> => inline.kind === "cite",
          )
        : [];
    const tokens = each.tokens;
    const clusters = clustersOf(tokens);
    for (let index = clusters.length - 1; index >= 0; index--) {
      const cluster = clusters[index] as { start: number; end: number };
      const cite = cites[index];
      if (!cite) continue;
      tokens.splice(cluster.start, cluster.end - cluster.start, special(cite));
      if (cite.note || cite.runs[0]?.script === "sup") trimBefore(tokens, cluster.start);
    }
  }
  return styled.slice(at);
}
