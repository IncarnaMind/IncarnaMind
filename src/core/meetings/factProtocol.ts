import { asGenerated } from "../../shared/aiText";
import { citationNode, type NodeJSON, withCitations } from "../../shared/blockJson";
import type { CellAnswer } from "../answers";
import { markdownToBlocks } from "../answers/markdown";
import { CITATION_NODE, GENERATED_MARK, type MarkedCitation } from "../api";
import { type FillSection, textOf } from "./fillPrompt";

export interface MeetingFact {
  id: string;
  topic: string;
  /** The topic of the call it is written under, shared word for word by that topic's facts. */
  heading: string;
  lines: string[];
  sections: FillSection[];
  claim: boolean;
  supersedes: string[];
  body: NodeJSON;
  citations: NodeJSON[];
}

export interface MeetingOverview {
  body: NodeJSON;
  citations: NodeJSON[];
}

/** Why a fact was left out, for the log: never its words. */
export type OmitReason =
  | "metadata"
  | "frame"
  | "citationNotFound"
  | "markers"
  | "text"
  | "noCitation"
  | "repeated";

export interface FactReply {
  facts: MeetingFact[];
  overview: MeetingOverview | null;
  omitted: number;
  /** Known invalid or conflicting IDs, once each in first-encounter order. */
  omittedIds: string[];
  omittedReasons: Record<string, OmitReason>;
  invalidFrames: number;
}

interface FactMetadata {
  topic: string;
  heading: string;
  citations: number[];
  lines: string[];
  sections: FillSection[];
  claim: boolean;
  supersedes: string[];
}

interface Frame {
  id: string | null;
  blocks: NodeJSON[];
  raw: NodeJSON[];
  closed: boolean;
  aligned: boolean;
}

const FACT_ID = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/;
const MAX_ITEMS = 128;
const MAX_METADATA = 16_384;
const MAX_BODY = 32_768;
const FACT_KEYS = ["topic", "heading", "citations", "lines", "sections", "claim", "supersedes"];
const SECTIONS: readonly FillSection[] = ["summary", "decisions", "actions", "questions"];
const TEXT_MARKS = new Set([GENERATED_MARK, "bold", "italic", "strike", "link"]);

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function sameValue(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) && Array.isArray(right))
    return (
      left.length === right.length && left.every((value, index) => sameValue(value, right[index]))
    );
  if (!record(left) || !record(right)) return false;
  const keys = Object.keys(left);
  return (
    keys.length === Object.keys(right).length &&
    keys.every((key) => Object.hasOwn(right, key) && sameValue(left[key], right[key]))
  );
}

function strings(value: unknown, pattern: RegExp): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= MAX_ITEMS &&
    value.every((item: unknown) => typeof item === "string" && pattern.test(item)) &&
    new Set(value).size === value.length
  );
}

function inventory(value: unknown): value is number[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.length <= MAX_ITEMS &&
    value.every(
      (item: unknown) =>
        typeof item === "number" && Number.isInteger(item) && item > 0 && item < 10_000,
    ) &&
    new Set(value).size === value.length
  );
}

function metadata(node: NodeJSON | undefined): Record<string, unknown> | null {
  if (node?.type !== "codeBlock" || node.attrs?.language !== "json") return null;
  if (node.content?.some((child) => child.type !== "text" || child.content)) return null;
  const json = textOf(node);
  if (json.length > MAX_METADATA || json.includes("[^")) return null;
  try {
    const parsed: unknown = JSON.parse(json);
    return record(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

const label = (value: unknown): value is string =>
  typeof value === "string" &&
  value.trim() !== "" &&
  value.length <= 240 &&
  !/[\p{Cc}\p{Zl}\p{Zp}]/u.test(value);

/** What a heading never shows: a Citation marker or a token for the User. */
const NOT_A_TITLE = /\[\^\d*\]|[{｛][^{}｛｝]*[}｝]/u;
/** A token for the User, with the possessive after it: what a topic loses to become a title. */
const TOKEN = /[{｛]+[^{}｛｝]*[}｝]+(?:['’]s\b|\s*的)?/gu;
const ADDRESS = /\b[LH]\d+\b/gu;

/**
 * The heading a fact goes under: its own, else its topic's words without markers or tokens.
 * `addresses` are the User's lines and headings as the model was shown them ("L3", "H2"): only
 * those are machine addresses, so a half-year such as "H2 targets" stays a title (#2306).
 */
function titleOf(heading: unknown, topic: string, addresses: ReadonlySet<string>): string | null {
  const addressed = (text: string) =>
    [...text.matchAll(ADDRESS)].some((match) => addresses.has(match[0]));
  if (label(heading) && !NOT_A_TITLE.test(heading) && !addressed(heading)) return heading.trim();
  const words = topic
    .replace(TOKEN, "")
    .replace(/\[\^\d*\]/gu, "")
    .replace(ADDRESS, (address) => (addresses.has(address) ? "" : address))
    .replace(/\s+/gu, " ")
    .trim();
  return words !== "" && !NOT_A_TITLE.test(words) ? words : null;
}

/**
 * The User's lines a fact names: their addresses, where a bare number is read as the address of
 * the line this fill listed under it ("lines":[1] for "L1"), and nothing else: a model wrote the
 * number in place of "L1", and every fact that did was left out (#2306).
 */
function linesOf(value: unknown, addresses: ReadonlySet<string>): string[] | null {
  if (!Array.isArray(value)) return null;
  const named: unknown[] = value.map((item: unknown) =>
    typeof item === "number" && addresses.has(`L${item}`) ? `L${item}` : item,
  );
  return strings(named, /^L[1-9]\d{0,5}$/) ? named : null;
}

function factMetadata(
  value: Record<string, unknown>,
  addresses: ReadonlySet<string>,
): FactMetadata | null {
  if (Object.keys(value).some((key) => !FACT_KEYS.includes(key))) return null;
  const { topic, citations, sections, claim } = value;
  const lines = linesOf(value.lines, addresses);
  const supersedes = Object.hasOwn(value, "supersedes") ? value.supersedes : [];
  const heading = label(topic) ? titleOf(value.heading, topic, addresses) : null;
  if (
    !label(topic) ||
    heading === null ||
    !inventory(citations) ||
    lines === null ||
    !Array.isArray(sections) ||
    sections.length > SECTIONS.length ||
    !sections.every((section: unknown): section is FillSection =>
      SECTIONS.some((allowed) => section === allowed),
    ) ||
    new Set(sections).size !== sections.length ||
    typeof claim !== "boolean" ||
    !strings(supersedes, FACT_ID)
  )
    return null;
  return { topic, heading, citations, lines, sections, claim, supersedes };
}

function heading(node: NodeJSON | undefined): string | null {
  if (node?.type !== "heading" || node.attrs?.level !== 3) return null;
  if (
    !node.content?.every(
      (child) =>
        child.type === "text" &&
        !child.content &&
        (child.marks ?? []).every((mark) => mark.type === GENERATED_MARK),
    )
  )
    return null;
  return textOf(node);
}

// Blocks erase fence delimiters; this rejects variants without reading controls out of code.
function invalidMetadataFences(markdown: string): Set<string> {
  const invalid = new Set<string>();
  let pending: string | null = null;
  let open: { closer: RegExp; key: string | null } | null = null;
  for (const line of markdown.replace(/\r\n?/g, "\n").split("\n")) {
    if (open) {
      if (open.closer.test(line)) {
        if (open.key !== null && line !== "```") invalid.add(open.key);
        open = null;
      }
      continue;
    }
    const fence = /^ {0,3}(`{3,}|~{3,})[ \t]*([^\s`]*)[^`]*$/.exec(line)?.[1];
    if (fence) {
      if (pending !== null && line !== "```json") invalid.add(pending);
      open = {
        closer: new RegExp(`^ {0,3}${fence[0] === "`" ? "`" : "~"}{${fence.length},}[ \\t]*$`),
        key: pending,
      };
      pending = null;
      continue;
    }
    if (/^ {0,3}#{1,6}(?:[ \t]|$)/.test(line)) {
      const control = heading(markdownToBlocks(line)[0]);
      const id = control?.startsWith("FACT ") ? control.slice(5) : null;
      pending = control === "OVERVIEW" ? "" : id !== null && FACT_ID.test(id) ? id : null;
    }
  }
  return invalid;
}

function framesOf(blocks: readonly NodeJSON[], raw: readonly NodeJSON[]) {
  const frames: Frame[] = [];
  let current: Frame | null = null;
  let invalidFrames = 0;
  for (const [index, block] of blocks.entries()) {
    if (block.type !== "heading") {
      if (current) {
        current.blocks.push(block);
        const original = raw[index];
        if (original) current.raw.push(original);
        else current.aligned = false;
      }
      continue;
    }
    const control = heading(block);
    const label = textOf(block);
    const original = heading(raw[index]);
    if (current && control === `END ${current.id ?? "OVERVIEW"}`) {
      current.closed = true;
      current.aligned &&= original === control;
      current = null;
      continue;
    }
    current = null;
    const id = label.startsWith("FACT ") ? label.slice(5) : undefined;
    if (label === "OVERVIEW" || (id !== undefined && FACT_ID.test(id))) {
      current = {
        id: id ?? null,
        blocks: [],
        raw: [],
        closed: false,
        aligned: control !== null && original === control,
      };
      frames.push(current);
    } else if (label === "FACT" || label.startsWith("FACT ")) invalidFrames++;
  }
  return { frames, invalidFrames };
}

function paragraph(node: NodeJSON | undefined, allowBullet: boolean): NodeJSON | null {
  if (!node) return null;
  let body = node;
  if (allowBullet && body.type === "bulletList" && body.content?.length === 1) {
    const item = body.content[0];
    if (item?.type !== "listItem" || item.content?.length !== 1) return null;
    const first = item.content[0];
    if (!first) return null;
    body = first;
  }
  if (body.type !== "paragraph" || !body.content || body.content.length > 1_024) return null;
  if (
    !body.content.every((child) => {
      if (child.content) return false;
      if (child.type === CITATION_NODE) return true;
      if (child.type === "hardBreak") return true;
      return (
        child.type === "text" &&
        typeof child.text === "string" &&
        (child.marks ?? []).every((mark) => TEXT_MARKS.has(mark.type))
      );
    })
  )
    return null;
  const text = textOf(body);
  return text.trim() !== "" && text.length <= MAX_BODY ? body : null;
}

function sessionReceipts(citations: readonly MarkedCitation[]) {
  const receipts = new Map<number, MarkedCitation | null>();
  for (const citation of citations) {
    if (receipts.has(citation.marker) && !sameValue(receipts.get(citation.marker), citation))
      receipts.set(citation.marker, null);
    else if (!receipts.has(citation.marker)) receipts.set(citation.marker, citation);
  }
  return receipts;
}

function checkedBody(
  frame: Frame,
  required: readonly number[],
  receipts: ReadonlyMap<number, MarkedCitation | null>,
): MeetingOverview | OmitReason {
  if (!frame.closed || !frame.aligned || frame.blocks.length !== 2 || frame.raw.length !== 2)
    return "frame";
  const body = paragraph(frame.blocks[1], frame.id !== null);
  const raw = paragraph(frame.raw[1], frame.id !== null);
  if (!body || !raw) return "frame";
  const markers = new Set<number>();
  let found = true;
  const projected = withCitations([raw], (marker) => {
    markers.add(marker);
    const receipt = receipts.get(marker);
    if (receipt?.check !== "found") {
      found = false;
      return null;
    }
    const { marker: _marker, ...citation } = receipt;
    return citationNode(citation);
  });
  if (!found) return "citationNotFound";
  if (markers.size !== required.length || required.some((marker) => !markers.has(marker)))
    return "markers";
  const generated = asGenerated([body])[0];
  if (!generated || !sameValue(asGenerated(projected)[0], generated)) return "text";
  const citations = (generated.content ?? []).filter((child) => child.type === CITATION_NODE);
  return citations.length > 0 ? { body: generated, citations } : "noCitation";
}

/**
 * Known invalid fact IDs count once; unknown frames are separate, and the overview is required.
 * `addresses`: the User's lines and headings as the model was shown them ("L1", "H2").
 */
export function parseFactReply(
  answer: Pick<CellAnswer, "markdown" | "blocks" | "citations">,
  addresses: readonly string[] = [],
): FactReply {
  const known = new Set(addresses);
  if (answer.markdown.length > 2_000_000 || answer.blocks.length > 20_000)
    return {
      facts: [],
      overview: null,
      omitted: 1,
      omittedIds: [],
      omittedReasons: {},
      invalidFrames: 1,
    };
  const raw = markdownToBlocks(answer.markdown);
  const { frames, invalidFrames } = framesOf(answer.blocks, raw);
  const invalidFences = invalidMetadataFences(answer.markdown);
  const receipts = sessionReceipts(answer.citations);
  const facts = new Map<string, { fact: MeetingFact; metadata: FactMetadata } | OmitReason>();
  let overview: MeetingOverview | null | undefined;
  let overviewInventory: number[] | undefined;
  for (const frame of frames) {
    frame.aligned &&= !invalidFences.has(frame.id ?? "");
    const parsed = metadata(frame.blocks[0]);
    const value = sameValue(parsed, metadata(frame.raw[0])) ? parsed : null;
    if (frame.id === null) {
      const required = value?.citations;
      const result =
        value && Object.keys(value).length === 1 && inventory(required)
          ? checkedBody(frame, required, receipts)
          : null;
      const checked = typeof result === "object" ? result : null;
      if (overview === undefined) {
        overview = checked;
        if (inventory(required)) overviewInventory = required;
      } else if (!sameValue(overview, checked) || !sameValue(overviewInventory, required)) {
        overview = null;
      }
      continue;
    }
    const fields = value ? factMetadata(value, known) : null;
    const checked = fields ? checkedBody(frame, fields.citations, receipts) : "metadata";
    if (!fields || typeof checked === "string") {
      facts.set(frame.id, typeof checked === "string" ? checked : "metadata");
      continue;
    }
    const { citations: _inventory, ...details } = fields;
    const next = { fact: { id: frame.id, ...details, ...checked }, metadata: fields };
    if (!facts.has(frame.id)) facts.set(frame.id, next);
    else if (!sameValue(facts.get(frame.id), next)) facts.set(frame.id, "repeated");
  }
  const kept: MeetingFact[] = [];
  const omittedIds: string[] = [];
  const omittedReasons: Record<string, OmitReason> = {};
  for (const [id, value] of facts) {
    if (typeof value === "string") {
      omittedIds.push(id);
      omittedReasons[id] = value;
    } else kept.push(value.fact);
  }
  return {
    facts: kept,
    overview: overview ?? null,
    omitted: omittedIds.length + (overview ? 0 : 1),
    omittedIds,
    omittedReasons,
    invalidFrames,
  };
}
