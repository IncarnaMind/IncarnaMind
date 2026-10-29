/**
 * An export's Citations in the Mind's citation style (#289): Citations side by side are one
 * cluster, as the editor shows them; each cluster is formatted, in the text or as a note, and
 * the Bibliography is added at the end. Numbered, IncarnaMind's own style, keeps its footnotes
 * and is never passed through here.
 */
import type { ResolvedCitationStyle } from "../../shared/citationStyles";
import { citedLocation } from "../../shared/citations";
import { translate } from "../../shared/i18n";
import type { Translate } from "../../shared/locations";
import { type SourceContext, sourceEntry, sourceKeyOf, sourcesOf } from "../../shared/sources";
import type { CitationFormatRequest, CitedWork, FormattedCitations, StyledRun } from "../api";
import { type Block, type Inline, type Pendings, trimTrailingSpace } from "../mindText";
import {
  type FigureInline,
  type FigureWriting,
  figureCited,
  figureSourcesOf,
  figureWithNote,
} from "./figures";

/** Every run of inline content in the Blocks, in order, mapped by `map`. */
function mapInlines(blocks: readonly Block[], map: (content: Inline[]) => Inline[]): Block[] {
  const visit = (block: Block): Block => {
    switch (block.kind) {
      case "paragraph":
      case "heading":
      case "question":
        return { ...block, content: map(block.content) };
      case "list":
        return { ...block, items: block.items.map((item) => item.map(visit)) };
      case "quote":
        return { ...block, content: block.content.map(visit) };
      case "table":
        return {
          ...block,
          rows: block.rows.map((row) =>
            row.map((cell) => ({ ...cell, content: cell.content.map(visit) })),
          ),
        };
      // A chart's sources, side by side, are one cluster: "Source: (Acme, 2025, p. 4; …)".
      case "chart":
        return { ...block, sources: map(block.sources) };
      default:
        return block;
    }
  };
  return blocks.map(visit);
}

/** Where a cluster starts in its content, how far it reaches, and its Citations. */
interface Cluster {
  start: number;
  /** One past its last Citation. */
  end: number;
  citations: Extract<Inline, { kind: "citation" }>[];
}

export const isBlank = (inline: Inline | undefined) =>
  inline?.kind === "text" && inline.text.trim() === "" && !inline.text.includes("\n");

/** What changes still waiting do to an inline, as one key: a cluster is all one or all another (#107). */
export const changeKey = (inline: Pendings | undefined): string =>
  `${inline?.inserted?.id ?? ""}\u0000${inline?.deleted?.id ?? ""}`;

/**
 * The clusters in one run of content: Citations with nothing but spaces
 * between them, that changes still waiting do the same to.
 */
function clustersIn(content: readonly Inline[]): Cluster[] {
  const found: Cluster[] = [];
  let index = 0;
  while (index < content.length) {
    const first = content[index];
    if (first?.kind !== "citation") {
      index++;
      continue;
    }
    const cluster: Cluster = { start: index, end: index + 1, citations: [first] };
    const alike = (inline: Inline | undefined): inline is Extract<Inline, { kind: "citation" }> =>
      inline?.kind === "citation" && changeKey(inline) === changeKey(first);
    for (;;) {
      const next = content[cluster.end];
      if (alike(next)) {
        cluster.citations.push(next);
        cluster.end++;
      } else if (isBlank(next) && alike(content[cluster.end + 1])) {
        cluster.end++;
      } else {
        break;
      }
    }
    found.push(cluster);
    index = cluster.end;
  }
  return found;
}

/** The clusters in one run of content, and the calculated figures whose inputs a style cites, in order. */
function citedIn(
  content: readonly Inline[],
): (Cluster | { start: number; end: number; figure: FigureInline })[] {
  const figures = content.flatMap((inline, start) =>
    inline.kind === "figure" && figureSourcesOf(inline).length > 0
      ? [{ start, end: start + 1, figure: inline }]
      : [],
  );
  return [...clustersIn(content), ...figures].sort((a, b) => a.start - b.start);
}

const sameFormat = (a: StyledRun, b: StyledRun) =>
  a.italic === b.italic &&
  a.bold === b.bold &&
  a.smallCaps === b.smallCaps &&
  a.underline === b.underline &&
  a.script === b.script &&
  a.link === b.link;

/** A cluster's runs without the work each belongs to, neighbours formatted alike joined. */
function runsOf(runs: FormattedCitations["clusters"][number]["runs"]): StyledRun[] {
  const joined: StyledRun[] = [];
  for (const { work: _, ...run } of runs) {
    const last = joined.at(-1);
    if (last && sameFormat(last, run))
      joined[joined.length - 1] = { ...last, text: last.text + run.text };
    else joined.push(run);
  }
  return joined;
}

/**
 * The Blocks with their Citations in `style`, and its Bibliography at the end: `format` is the
 * core's `formatCitations`. A calculated figure's inputs are a cluster of their own, after its
 * text (./figures), as the editor shows them. An entry too thin to cite is written with the
 * details it has, never a placeholder the User would send (#1910); the Saved line counts them
 * instead. Blocks with no Citation come back as they were.
 */
export async function styleCitations(
  blocks: readonly Block[],
  style: ResolvedCitationStyle,
  format: (request: CitationFormatRequest) => Promise<FormattedCitations>,
  figures: FigureWriting,
): Promise<Block[]> {
  const works: CitedWork[][] = [];
  mapInlines(blocks, (content) => {
    for (const cited of citedIn(content)) {
      works.push(
        "figure" in cited
          ? figureSourcesOf(cited.figure).map((source) => source.work)
          : cited.citations.map((citation) => citation.work),
      );
    }
    return content;
  });
  if (works.length === 0) return [...blocks];

  const formatted = await format({
    style: style.id,
    clusters: works.map((each) => ({ works: each })),
  });
  let next = 0;
  const styled = mapInlines(blocks, (content) => {
    const clusters = citedIn(content);
    if (clusters.length === 0) return content;
    const out: Inline[] = [];
    let at = 0;
    for (const cluster of clusters) {
      out.push(...content.slice(at, cluster.start));
      const runs = runsOf(formatted.clusters[next]?.runs ?? []);
      next++;
      const note = formatted.form === "note";
      if ("figure" in cluster) {
        out.push(...figureCited(cluster.figure, runs, note, figures));
        at = cluster.end;
        continue;
      }
      // A note's number, or a raised number, goes right after the word, as in print.
      if (note || runs[0]?.script === "sup") trimTrailingSpace(out);
      const [first] = cluster.citations;
      const failed = cluster.citations.flatMap((citation) =>
        citation.footnote.failed ? [citation.footnote] : [],
      );
      out.push({
        kind: "cite",
        runs,
        note,
        unverified: cluster.citations.some((citation) => citation.footnote.unverified),
        of: cluster.citations
          .map((citation) =>
            [
              citation.work.documentId ?? "",
              citation.work.contentHash ?? "",
              citation.footnote.source,
            ].join("\n"),
          )
          .join("\n"),
        ...(failed.length > 0 && { failed }),
        ...(first?.inserted && { inserted: first.inserted }),
        ...(first?.deleted && { deleted: first.deleted }),
      });
      at = cluster.end;
    }
    out.push(...content.slice(at));
    return out;
  });
  if (formatted.bibliography.length === 0 || style.heading === null) return styled;
  return [
    ...styled,
    {
      kind: "bibliography",
      heading: style.heading,
      items: formatted.bibliography.map((entry) => ({
        label: entry.label,
        runs: entry.runs,
      })),
      hangingIndent: formatted.hangingIndent,
    },
  ];
}

/** The Blocks with each calculated figure followed by its note, for Numbered (./figures). */
export function withFigureNotes(blocks: readonly Block[], figures: FigureWriting): Block[] {
  return mapInlines(blocks, (content) =>
    content.flatMap((inline) =>
      inline.kind === "figure" ? figureWithNote(inline, figures) : [inline],
    ),
  );
}

/**
 * The Blocks with a Bibliography at the end (#102), for a Numbered Mind that shows one: each
 * Document its Citations cite, once, with the Locations cited. A Citation a pending change
 * adds isn't in the Blocks of a read that leaves pending changes out, so it isn't counted; a
 * Word export, whose Blocks show them as tracked changes, counts it. Blocks with no Citation
 * come back as they were.
 */
export function addSources(
  blocks: readonly Block[],
  context: SourceContext,
  heading: string,
): Block[] {
  const cited: Parameters<typeof sourcesOf>[0][number][] = [];
  mapInlines(blocks, (content) => {
    for (const inline of content) {
      if (inline.kind === "citation") cited.push(inline.work);
    }
    return content;
  });
  const sources = sourcesOf(cited, context);
  if (sources.length === 0) return [...blocks];
  return [
    ...blocks,
    {
      kind: "bibliography",
      heading,
      items: sources.map((source) => ({
        label: null,
        runs: [{ text: sourceEntry(source, context.language) }],
      })),
      hangingIndent: false,
    },
  ];
}

/**
 * The Blocks with their Citations as the numbers of their Documents in square brackets, "[1]",
 * and at the end a list of those Documents under `heading` (#1600): for a Numbered Mind whose
 * export puts its Citations in a list instead of footnotes. The Documents are numbered in the
 * order they are first cited and each is listed once, with the Locations cited; the list is the
 * Bibliography's entries, and is written whether the Mind shows its Bibliography or not. A
 * Location whose quote wasn't found keeps the `unverified` mark. A Citation a change still
 * waiting adds is in the Blocks of a Word export, as a tracked insertion, so it is numbered and
 * listed with the rest; a PDF's Blocks leave it out. Blocks with no Citation come back as they
 * were.
 */
export function listCitations(
  blocks: readonly Block[],
  context: SourceContext,
  heading: string,
  unverified: string,
): Block[] {
  const cited: Extract<Inline, { kind: "citation" }>[] = [];
  mapInlines(blocks, (content) => {
    for (const inline of content) if (inline.kind === "citation") cited.push(inline);
    return content;
  });
  const sources = sourcesOf(
    cited.map((citation) => citation.work),
    context,
    "cited",
  );
  if (sources.length === 0) return [...blocks];
  const numbers = new Map<string, number>();
  const numberOf = (citation: (typeof cited)[number]) => {
    const key = sourceKeyOf(citation.work, context);
    const known = numbers.get(key);
    if (known !== undefined) return known;
    numbers.set(key, numbers.size + 1);
    return numbers.size;
  };
  for (const citation of cited) numberOf(citation);

  const styled = mapInlines(blocks, (content) => {
    const clusters = clustersIn(content);
    if (clusters.length === 0) return content;
    const out: Inline[] = [];
    let at = 0;
    for (const cluster of clusters) {
      out.push(...content.slice(at, cluster.start));
      const [first] = cluster.citations;
      const failed = cluster.citations.flatMap((citation) =>
        citation.footnote.failed ? [citation.footnote] : [],
      );
      const marker = [...new Set(cluster.citations.map(numberOf))].sort((a, b) => a - b);
      out.push({
        kind: "cite",
        runs: [{ text: `[${marker.join(", ")}]` }],
        note: false,
        unverified: false,
        ...(failed.length > 0 && { failed }),
        ...(first?.inserted && { inserted: first.inserted }),
        ...(first?.deleted && { deleted: first.deleted }),
      });
      at = cluster.end;
    }
    out.push(...content.slice(at));
    return out;
  });

  const t: Translate = (key, params) => translate(context.language, key, params);
  const unverifiedAt = new Map<string, Set<string>>();
  for (const citation of cited) {
    if (!citation.footnote.unverified) continue;
    const key = sourceKeyOf(citation.work, context);
    const places = unverifiedAt.get(key) ?? new Set<string>();
    places.add(citedLocation(citation.work, t) ?? "");
    unverifiedAt.set(key, places);
  }
  return [
    ...styled,
    {
      kind: "bibliography",
      heading,
      items: sources.map((source, index) => {
        const places = unverifiedAt.get(source.key);
        const marked = {
          ...source,
          locations: source.locations.map((place) =>
            places?.has(place) ? `${place} ${unverified}` : place,
          ),
        };
        const entry = sourceEntry(marked, context.language);
        return {
          label: [{ text: `[${index + 1}]` }],
          runs: [{ text: places?.has("") ? `${entry} ${unverified}` : entry }],
        };
      }),
      hangingIndent: false,
    },
  ];
}
