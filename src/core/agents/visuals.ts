/**
 * The pictures and charts in what an outside agent writes into a Note (#3413), put in place as the
 * Note's own Blocks once its Markdown is read, with each picture held apart while it is read
 * (./pictures). A line that is only pictures becomes those pictures. A chart is written in the form
 * IncarnaMind's assistant writes one (#1091): a table of its figures, each cited with its token,
 * and right under it a ```chart block of JSON giving its kind and title, which becomes the chart
 * Block of that table, as "Chart from table" draws one, each value keeping its cell's Citation; a
 * value whose token wasn't this agent's keeps the words that say so, uncited. The kind and title
 * are the agent's: nothing here reads what the figures mean. What can't be put in place is a line
 * that says why.
 */
import { asGenerated } from "../../shared/aiText";
import { CHART_KINDS, type ChartKind } from "../../shared/charts";
import { inertBrackets } from "../../shared/inertBrackets";
import type { NodeJSON } from "../answers/blocks";
import { BLOCK_ID_ATTRIBUTE, PICTURE_NODE } from "../api";
import type { Language } from "../language";
import { chartOfTable } from "../tools/minds/charts";
import {
  HELD_PICTURE,
  HOLDING_PICTURES,
  type NamedPicture,
  type PictureRefusal,
  pictureName,
  type ReadPicture,
} from "./pictures";

/** The language a fenced block names to be a chart. */
export const CHART_FENCE = "chart";

export type ChartRefusal = "noTable" | "json" | "kind" | "noNumbers" | "needsTwo";

/** A picture or chart left out, by what the agent wrote: `name` is what the Note's line calls it. */
export type VisualRefused = { item: string; name: string } & (
  | { kind: "picture"; why: PictureRefusal }
  | { kind: "chart"; why: ChartRefusal }
);

export interface NoteVisuals {
  /** Each picture's source as it was read for this call (`readPictures`). */
  pictures: ReadonlyMap<string, ReadPicture>;
  language: Language;
  /** What a token it can't cite with reads as, which a chart's value is read without. */
  notFound: string;
  /** The Note's line about one left out, in the interface language. */
  line(refused: VisualRefused): string;
  newId(): string;
}

const isKind = (value: unknown): value is ChartKind =>
  (CHART_KINDS as readonly unknown[]).includes(value);

/** The chart a ```chart block asks for of `table` (null: none right above it), or why none. */
export function chartUnder(
  table: NodeJSON | null,
  tableId: string,
  fence: string,
  language: Language,
): { chart: NodeJSON } | { refused: ChartRefusal } {
  let asked: unknown;
  try {
    asked = JSON.parse(fence);
  } catch {
    return { refused: "json" };
  }
  if (typeof asked !== "object" || asked === null || Array.isArray(asked)) {
    return { refused: "json" };
  }
  const { kind, title } = asked as { kind?: unknown; title?: unknown };
  if (kind !== undefined && !isKind(kind)) return { refused: "kind" };
  if (!table) return { refused: "noTable" };
  const drawn = chartOfTable(
    table,
    tableId,
    { kind: kind ?? null, title: typeof title === "string" ? title.trim() : "" },
    language,
    null,
  );
  if ("chart" in drawn) return drawn;
  return { refused: drawn.problem === "needsTwo" ? "needsTwo" : "noNumbers" };
}

const textOf = (node: NodeJSON): string =>
  (node.content ?? []).map((child) => (child.type === "text" ? (child.text ?? "") : "")).join("");

/** The pictures a paragraph is made of, by their markers; null when it holds anything else. */
function picturesOnly(node: NodeJSON): number[] | null {
  if (node.type !== "paragraph") return null;
  const content = node.content ?? [];
  if (!content.every((child) => child.type === "text" || child.type === "hardBreak")) return null;
  const text = textOf(node);
  const markers = [...text.matchAll(HELD_PICTURE)].map((match) => Number(match[1]));
  return markers.length > 0 && text.replace(HELD_PICTURE, "").trim() === "" ? markers : null;
}

const clipped = (text: string) => (text.length <= 80 ? text : `${text.slice(0, 79)}…`);

/** How a picture's source is named back to the agent: a data: URL by its start alone. */
const itemOf = (picture: NamedPicture) =>
  picture.source.startsWith("data:")
    ? `${picture.source.slice(0, picture.source.indexOf(",") + 1)}…`
    : picture.source;

/** A table whose cells read without the words a token it can't cite with left: the value stays, uncited. */
function withoutNotFound(table: NodeJSON, notFound: string): NodeJSON {
  const words = [inertBrackets(notFound), notFound];
  const clean = (node: NodeJSON): NodeJSON =>
    node.type === "text"
      ? { ...node, text: words.reduce((text, each) => text.replaceAll(each, ""), node.text ?? "") }
      : node.content
        ? { ...node, content: node.content.map(clean) }
        : node;
  return clean(table);
}

/**
 * The Blocks with their pictures and charts in place, and what was left out. `held` are the
 * pictures the Markdown was read with, by marker.
 */
export function placeVisuals(
  nodes: readonly NodeJSON[],
  held: readonly NamedPicture[],
  visuals: NoteVisuals,
): { nodes: NodeJSON[]; refused: VisualRefused[] } {
  const refused: VisualRefused[] = [];
  const line = (left: VisualRefused): NodeJSON => {
    refused.push(left);
    return asGenerated([
      { type: "paragraph", content: [{ type: "text", text: visuals.line(left) }] },
    ])[0] as NodeJSON;
  };
  const picture = (n: number): NodeJSON | null => {
    const named = held[n];
    if (!named) return null;
    const read = visuals.pictures.get(named.source) ?? { refused: "unreadable" as const };
    if ("refused" in read) {
      return line({
        kind: "picture",
        why: read.refused,
        item: itemOf(named),
        name: pictureName(named),
      });
    }
    return { type: PICTURE_NODE, attrs: { src: read.src, alt: named.alt || null } };
  };
  // A picture in code is code; in words, its alt text stays and the agent is told.
  const inWords = (node: NodeJSON, code: boolean): NodeJSON => {
    if (node.type === "text") {
      const text = node.text ?? "";
      if (text.search(HOLDING_PICTURES) < 0) return node;
      const inCode = code || (node.marks?.some((mark) => mark.type === "code") ?? false);
      return {
        ...node,
        text: text.replace(HELD_PICTURE, (_, n: string) => {
          const named = held[Number(n)];
          if (!named) return "";
          if (inCode) return named.raw;
          refused.push({
            kind: "picture",
            why: "own-line",
            item: itemOf(named),
            name: pictureName(named),
          });
          return named.alt;
        }),
      };
    }
    if (!node.content) return node;
    const inCode = code || node.type === "codeBlock";
    const content = node.content
      .map((child) => inWords(child, inCode))
      .filter((child) => child.type !== "text" || (child.text ?? "") !== "");
    return { ...node, content };
  };

  const placed: NodeJSON[] = [];
  for (const node of nodes) {
    if (node.type === "codeBlock" && node.attrs?.language === CHART_FENCE) {
      const fence = textOf(node);
      const above = placed.at(-1);
      const table = above?.type === "table" ? above : null;
      const kept = table?.attrs?.[BLOCK_ID_ATTRIBUTE];
      const tableId = typeof kept === "string" ? kept : visuals.newId();
      const drawn = chartUnder(
        table && withoutNotFound(table, visuals.notFound),
        tableId,
        fence,
        visuals.language,
      );
      if ("refused" in drawn) {
        placed.push(
          line({ kind: "chart", why: drawn.refused, item: clipped(fence.trim()), name: "" }),
        );
        continue;
      }
      // The chart draws its table by the table's id, which a Block keeps once it is given one.
      if (table && typeof kept !== "string") {
        placed[placed.length - 1] = {
          ...table,
          attrs: { ...table.attrs, [BLOCK_ID_ATTRIBUTE]: tableId },
        };
      }
      placed.push(drawn.chart);
      continue;
    }
    const markers = picturesOnly(node);
    if (markers) {
      for (const n of markers) {
        const each = picture(n);
        if (each) placed.push(each);
      }
      continue;
    }
    placed.push(inWords(node, false));
  }
  return { nodes: placed, refused };
}
