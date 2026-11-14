/**
 * The paid proof of the ask for a fill's records (#3099): a saved fill's first reply is given back
 * as the model wrote it, and only the ask for its markers' records goes to a real model. Its output
 * is counts only: never a line of a call or a sentence of a note.
 *
 * Runs only with INCARNAMIND_ASK_ARM, and every other argument then:
 * - INCARNAMIND_ASK_ARM: A (the saved fills whose reply wrote markers and called no `cite`, 3 tries
 *   each), B (the same, 1 try each) or C (six that cited and filled, their records withheld, 1 try
 *   each: the three lowest call ids of each language, other than A's, each its lowest run tag);
 * - INCARNAMIND_ASK_RUNS: the folders of saved fills, absolute, separated by commas;
 * - INCARNAMIND_ASK_OUT: the folder its files go to, absolute; every arm keeps its spend there;
 * - INCARNAMIND_ASK_MODEL: the model's id, which names its provider (claude-… or deepseek-…);
 * - INCARNAMIND_ASK_KEY_VAR: the name of the variable that holds that provider's key;
 * - INCARNAMIND_ASK_DRY=1: every request and file is built as in a real run, and nothing is sent;
 * - INCARNAMIND_ASK_SELFCHECK, with no key: the ask's reply is scripted, and the score is read and
 *   held to what the mode must give: "own" (arm C, each reply's own withheld records), "moved"
 *   (the same, with the first case's first marker quoting the next line the check finds), "none"
 *   (no records), "footnotes" (arm A, the quotes a reply wrote as footnote lines) or "every" (arm A,
 *   one try each: every marker given one found record, each quoting its own Transcript line).
 * Beside the arm's table it keeps, per try, a record of the note and of the ask's records in counts
 * (`notes-<arm>.jsonl`), so a run can be scored again with nothing sent.
 * No request goes that could take the spend of all arms past US$0.25.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join } from "node:path";
import { gunzipSync } from "node:zlib";
import type { LanguageModelV4 } from "@ai-sdk/provider";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { afterAll, describe, expect, test, vi } from "vitest";
import type { Core, Meeting, MeetingFill } from "../../src/core";
import type { LogFields } from "../../src/core/adapters";
import { estimateTokens } from "../../src/core/answers/context";
import { withJsonFencesClosed } from "../../src/core/answers/jsonFences";
import { questionOf } from "../../src/core/answers/judge";
import { CITATION_NODE, GENERATED_MARK } from "../../src/core/api";
import { costOf, inCurrency } from "../../src/core/cost/price";
import type { Language } from "../../src/core/language";
import { catalogModel } from "../../src/core/providers/catalog";
import * as chatModels from "../../src/core/providers/models";
import { answerSentences } from "../../src/shared/answerSentences";
import { translate } from "../../src/shared/i18n";
import { isPartialMeetingFill } from "../../src/shared/meetingFill";
import { findQuote } from "../../src/shared/quoteMatch";
import { createTempDataFolder } from "../helpers/core";
import { createRequestLedger } from "../helpers/meetingFillObservation";
import { connectToMind } from "../helpers/mindClient";
import { readMind, writeMind } from "../helpers/minds";
import { type ScriptedReply, scriptedModel } from "../helpers/models";
import { transcribingCore } from "../helpers/transcription";

const ARM = process.env.INCARNAMIND_ASK_ARM;
const DRY = process.env.INCARNAMIND_ASK_DRY === "1";
const SELFCHECK = process.env.INCARNAMIND_ASK_SELFCHECK;
const SELFCHECK_ARMS: Readonly<Record<string, string>> = {
  own: "C",
  moved: "C",
  none: "C",
  footnotes: "A",
  every: "A",
};
const CAP_USD = 0.25;
const TRIES: Readonly<Record<string, number>> = { A: 3, B: 1, C: 1 };
const SPEND_FILE = "spend.json";

/** The arguments, read only once the proof is asked for. */
function argumentsOf() {
  const runs = (process.env.INCARNAMIND_ASK_RUNS ?? "").split(",").filter(Boolean);
  const out = process.env.INCARNAMIND_ASK_OUT ?? "";
  const model = process.env.INCARNAMIND_ASK_MODEL ?? "";
  const keyVar = process.env.INCARNAMIND_ASK_KEY_VAR ?? "";
  const provider: "anthropic" | "deepseek" | null = model.startsWith("claude-")
    ? "anthropic"
    : model.startsWith("deepseek-")
      ? "deepseek"
      : null;
  const sent = !DRY && SELFCHECK === undefined;
  const key = sent ? (process.env[keyVar] ?? "") : "a-made-up-key-nothing-is-sent";
  if (
    !ARM ||
    TRIES[ARM] === undefined ||
    runs.length === 0 ||
    !runs.every(isAbsolute) ||
    !isAbsolute(out) ||
    !provider ||
    (SELFCHECK !== undefined && (DRY || SELFCHECK_ARMS[SELFCHECK] !== ARM)) ||
    (sent && (!/^[A-Z][A-Z0-9_]+$/.test(keyVar) || key.trim() === ""))
  ) {
    throw new Error("Invalid arguments for the ask's proof: see this file's comment.");
  }
  const price = catalogModel(provider, model)?.price;
  if (!price) throw new Error("The model has no catalog price.");
  // A scripted ask gives every try the same records: "every" reads each fill once.
  const tries = SELFCHECK === "every" ? 1 : (TRIES[ARM] ?? 1);
  return { arm: ARM, runs, out, model, provider, key, price, sent, tries };
}

type Part = { type: string; [key: string]: unknown };

/** A receipt's reply, back in its stream's parts: text and the JSON parts the recorder wrote. */
function partsOf(raw: string): Part[] {
  const parts: Part[] = [];
  let text = "";
  let at = 0;
  while (at < raw.length) {
    if (raw.startsWith('{"type":"', at)) {
      let depth = 0;
      let quoted = false;
      let escaped = false;
      let end = at;
      for (; end < raw.length; end++) {
        const char = raw[end];
        if (quoted) {
          if (escaped) escaped = false;
          else if (char === "\\") escaped = true;
          else if (char === '"') quoted = false;
        } else if (char === '"') quoted = true;
        else if (char === "{") depth++;
        else if (char === "}" && --depth === 0) break;
      }
      try {
        const part = JSON.parse(raw.slice(at, end + 1)) as Part;
        if (text) parts.push({ type: "text", text });
        text = "";
        parts.push(part);
        at = end + 1;
        continue;
      } catch {
        // Text that happens to start like a part is text.
      }
    }
    text += raw[at];
    at++;
  }
  if (text) parts.push({ type: "text", text });
  return parts;
}

const textOf = (parts: readonly Part[]) =>
  parts
    .filter((part) => part.type === "text")
    .map((part) => String(part.text))
    .join("");

interface Record_ {
  marker: number;
  quote: string;
}

const citeRecords = (parts: readonly Part[]): Record_[] =>
  parts.flatMap((part) => {
    if (part.type !== "tool-call" || part.toolName !== "cite") return [];
    let input: unknown = part.input;
    try {
      if (typeof input === "string") input = JSON.parse(input);
    } catch {
      // A call the model wrote malformed gave the app no records either.
      input = null;
    }
    const list = (input as { citations?: unknown } | null)?.citations;
    return Array.isArray(list)
      ? list.flatMap((each: unknown) => {
          const { marker, quote } = (each ?? {}) as { marker?: unknown; quote?: unknown };
          return typeof marker === "number" && typeof quote === "string" ? [{ marker, quote }] : [];
        })
      : [];
  });

interface Cue {
  text: string;
}
interface Saved {
  name: string;
  call: string;
  language: Language;
  provider: string;
  filled: boolean;
  requests: Part[][];
  cues: Cue[];
}

const FRAMES = /^ {0,3}#{1,6}\s+FACT\s/m;
const MARKER = /\[\^\d{1,4}\]/;

function savedFills(runs: readonly string[]): Saved[] {
  return runs
    .flatMap((folder) =>
      readdirSync(folder)
        .filter((file) => file.endsWith(".receipt.json.gz"))
        .map((file) => join(folder, file)),
    )
    .map((path) => {
      const receipt = JSON.parse(gunzipSync(readFileSync(path)).toString()) as {
        call: string;
        provider: string;
        quality: { fill_state: string };
        evidence: { raw_replies: string[]; saved_cues: Cue[] };
      };
      return {
        name: `${basename(join(path, ".."))}/${basename(path, ".receipt.json.gz")}`,
        call: receipt.call,
        language: receipt.call.startsWith("reserved-zh-") ? ("zh-CN" as const) : ("en" as const),
        provider: receipt.provider,
        filled: receipt.quality.fill_state === "filled",
        requests: receipt.evidence.raw_replies.map(partsOf),
        cues: receipt.evidence.saved_cues,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

const called = (parts: readonly Part[]) => parts.some((part) => part.type === "tool-call");

/** The fills the ask goes for: their first request wrote the ledger with markers and called nothing. */
const askable = (fill: Saved) => {
  const first = fill.requests[0] ?? [];
  return !called(first) && FRAMES.test(textOf(first)) && MARKER.test(textOf(first));
};

function picked(fills: readonly Saved[], arm: string): Saved[] {
  const asked = fills.filter(askable);
  if (arm !== "C") return asked;
  const askedCalls = new Set(asked.map((fill) => fill.call));
  const cited = fills.filter(
    (fill) =>
      fill.provider === "anthropic" &&
      fill.filled &&
      !askedCalls.has(fill.call) &&
      citeRecords(fill.requests[0] ?? []).length > 0 &&
      fill.requests.some((parts) => FRAMES.test(textOf(parts))),
  );
  return (["en", "zh-CN"] as const).flatMap((language) => {
    const calls = [
      ...new Set(cited.filter((fill) => fill.language === language).map((f) => f.call)),
    ]
      .sort()
      .slice(0, 3);
    return calls.flatMap((call) => cited.filter((fill) => fill.call === call).slice(0, 1));
  });
}

/** The reply given back as the fill's first: arm C's ledger with its `cite` records withheld. */
function firstReply(fill: Saved): { text: string; own: Record_[] } {
  const at = fill.requests.findIndex((parts) => FRAMES.test(textOf(parts)));
  // A model may call cite in the request that writes the ledger, after its text.
  return {
    text: textOf(fill.requests[at] ?? []),
    own: fill.requests.slice(0, at + 1).flatMap(citeRecords),
  };
}

interface Fact {
  sentence: string;
  markers: number[];
}

const plain = (text: string) =>
  text
    .replace(/\[\^\d{1,4}\]/g, "")
    .replace(/\s+([.,;:!?。，；：！？])/g, "$1")
    .replace(/\s+/g, " ")
    .trim();

/**
 * The fact frames the reply closed, and its overview's sentence: what the note may say. Read as the
 * app reads the reply, with the json fences it closes closed: an open one would hide every line
 * after it in its frame.
 */
function closedFacts(reply: string): { facts: Fact[]; overview: Fact | null } {
  const facts: Fact[] = [];
  let overview: Fact | null = null;
  let open: { id: string; body: string[] } | null = null;
  let fenced = false;
  for (const line of withJsonFencesClosed(reply).split("\n")) {
    const start = /^ {0,3}#{1,6}\s+(?:FACT\s+(\S+)|(OVERVIEW))\s*$/.exec(line);
    const end = /^ {0,3}#{1,6}\s+END\s+(\S+)\s*$/.exec(line);
    if (start) {
      open = { id: start[1] ?? "OVERVIEW", body: [] };
      fenced = false;
    } else if (end && open && end[1] === open.id) {
      const sentence = open.body.join(" ");
      const fact = {
        sentence: plain(sentence),
        markers: [...sentence.matchAll(/\[\^(\d{1,4})\]/g)].map((match) => Number(match[1])),
      };
      if (open.id === "OVERVIEW") overview = fact;
      else facts.push(fact);
      open = null;
    } else if (open) {
      if (/^ {0,3}(?:`{3,}|~{3,})/.test(line)) fenced = !fenced;
      else if (!fenced && line.trim() !== "") open.body.push(line.trim());
    }
  }
  return { facts, overview };
}

const footnoteQuotes = (reply: string): Map<number, string> =>
  new Map(
    [...reply.matchAll(/^\[\^(\d{1,4})\]:.*"([^"]+)"\s*$/gm)].map((match) => [
      Number(match[1]),
      match[2] as string,
    ]),
  );

/** The note's AI paragraphs and bullets: their words and their Citations' quotes and checks. */
function aiUnits(doc: ProseMirrorNode) {
  const units: { text: string; citations: { quote: string; check: string }[] }[] = [];
  doc.descendants((node) => {
    if (node.type.name !== "paragraph") return true;
    let ai = false;
    const citations: { quote: string; check: string }[] = [];
    node.descendants((child) => {
      if (child.isText && child.marks.some((mark) => mark.type.name === GENERATED_MARK)) ai = true;
      if (child.type.name === CITATION_NODE)
        citations.push({
          quote: String(child.attrs.quote ?? ""),
          check: String(child.attrs.check),
        });
    });
    if (ai) units.push({ text: plain(node.textContent), citations });
    return false;
  });
  return units;
}

/** The cue a quote is on: the first whose words hold it. */
const lineOf = (cues: readonly Cue[], quote: string) =>
  cues.findIndex((cue) => plain(cue.text).includes(plain(quote)));

interface Try {
  arm: string;
  /** Which of the arm's fills, from 1: two may be runs of the same call. */
  fill: number;
  case: string;
  language: Language;
  try: number;
  void: string;
  filled: boolean;
  closed: number;
  written: number;
  sameSentences: boolean;
  quotesFound: boolean;
  /** Whether the line reads partly filled in. */
  partial: boolean;
  asked: number;
  /** The ask's records whose quote the check didn't find. */
  dropped: number;
  /** The ask's records beyond the distinct quotes the note shows: the first run's "dropped". */
  beyondNoteQuotes: number;
  ownCompared: number;
  sameLine: number;
  footnoteCompared: number;
  footnoteSame: number;
  seconds: number;
  usd: number;
  /** When its requests were sent (ISO 8601): a provider's price can depend on the hour. */
  sentAt: string[];
}

const results: Try[] = [];
const otherLines: string[] = [];
/** What the self-check's scripted ask reports it used, whole as a provider's report is. */
const SCRIPTED_USAGE = {
  usage: {
    inputTokens: { total: 2_000, noCache: 2_000, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 300, text: 300, reasoning: 0 },
  },
};

/** "moved": the case and marker whose record the self-check moved to another line. */
const movedMarkers: string[] = [];

/**
 * The self-check's records for the Answer the ask shows: each marker's sentence, as a model would
 * name it, with the quote `quotes` gives it; with `once`, only where the marker is first written. A
 * marker before a sentence's first word cites the sentence before it.
 */
function scriptedRecords(
  answer: string,
  passages: readonly { id: string; text: string }[],
  quotes: ReadonlyMap<number, string>,
  move: ((marker: number, quote: string) => string | null) | null,
  once = false,
) {
  const records: { sentence: string; passage: string; quote: string }[] = [];
  const given = new Set<number>();
  let previous = "";
  for (const sentence of answerSentences(answer)) {
    const lead = /^(?:\s*\[\^\d{1,4}\])+/.exec(sentence.text)?.[0] ?? "";
    const words = plain(sentence.text);
    for (const found of sentence.text.matchAll(/\[\^(\d{1,4})\]/g)) {
      const marker = Number(found[1]);
      const own = quotes.get(marker);
      if (own === undefined || (once && given.has(marker))) continue;
      given.add(marker);
      const quote = move?.(marker, own) ?? own;
      const passage = passages.find((each) => each.text.includes(quote));
      const cited = (found.index ?? 0) < lead.length ? previous : words;
      if (passage && cited !== "") records.push({ sentence: cited, passage: passage.id, quote });
    }
    if (words !== "") previous = words;
  }
  return records;
}
let stoppedAtCap = false;

/**
 * "every": a quote of its own for each marker the ask's Answer holds, found in a Passage: a
 * Transcript line, or half of one where a short call has fewer lines than markers.
 */
function everyQuotes(
  answer: string,
  passages: readonly { id: string; text: string }[],
  cues: readonly Cue[],
): Map<number, string> {
  const lines = cues.map((cue) => cue.text.trim());
  const halves = lines.flatMap((line) => {
    const chars = [...line];
    const middle = Math.floor(chars.length / 2);
    return [chars.slice(0, middle).join("").trim(), chars.slice(middle).join("").trim()];
  });
  const quotes = [...new Set([...lines, ...halves])].filter(
    (text) => text !== "" && passages.some((passage) => passage.text.includes(text)),
  );
  const markers = [...new Set([...answer.matchAll(/\[\^(\d{1,4})\]/g)].map((m) => Number(m[1])))];
  if (markers.length > quotes.length) throw new Error("Too few Transcript lines to quote.");
  return new Map(markers.map((marker, at) => [marker, quotes[at] ?? ""]));
}

/** The text of a request's messages, as the model was shown it. */
function promptText(prompt: unknown): string {
  if (!Array.isArray(prompt)) return "";
  return prompt
    .flatMap((message: unknown) => {
      const content = (message as { content?: unknown } | null)?.content;
      if (typeof content === "string") return [content];
      if (!Array.isArray(content)) return [];
      return content.flatMap((part: unknown) => {
        const { type, text } = (part ?? {}) as { type?: unknown; text?: unknown };
        return type === "text" && typeof text === "string" ? [text] : [];
      });
    })
    .join("\n");
}

/** Text with its markers, spaces and punctuation taken out and its width folded. */
const folded = (text: string) =>
  text
    .normalize("NFKC")
    .replace(/\[\^\d{1,4}\]/g, "")
    .replace(/[\s\p{P}]+/gu, "")
    .toLowerCase();

/** The markers a sentence holds after its first word: one before it is the sentence before's. */
function ownMarkers(sentence: string): number[] {
  const first = [...sentence.matchAll(/\[\^\d{1,4}\]|[\p{L}\p{N}]/gu)].find(
    (found) => !found[0].startsWith("["),
  );
  return first
    ? [...sentence.slice(first.index).matchAll(/\[\^(\d{1,4})\]/g)].map((found) => Number(found[1]))
    : [];
}

/** The longest stretch of the quote in the line, both folded, as a share of the quote. */
function longestShare(quote: string, line: string): number {
  const needle = [...folded(quote)];
  const text = [...folded(line)];
  if (needle.length === 0) return 0;
  let best = 0;
  const row = new Array<number>(text.length + 1).fill(0);
  for (const char of needle) {
    let diagonal = 0;
    for (let at = 1; at <= text.length; at++) {
      const above = row[at] ?? 0;
      row[at] = char === text[at - 1] ? diagonal + 1 : 0;
      best = Math.max(best, row[at] ?? 0);
      diagonal = above;
    }
  }
  return Math.round((best / needle.length) * 100) / 100;
}

interface AskedRecord {
  sentence: string;
  quote: string;
}

/**
 * The ask's records in counts. A found record takes a marker as the app's reading does: the first
 * of its sentence's markers no earlier record took, or none when a marker of that sentence took the
 * same quote already. Found: a Citation of the note, else in one Transcript line by the app's quote
 * matching. For one not found: whether two adjacent lines hold it, whether it is there once spaces,
 * punctuation and width are folded, and the longest stretch of it in one line. Marker 0 with no
 * record before it: its sentence is none of the Answer's.
 */
function readRecords(
  view: string,
  records: readonly AskedRecord[],
  lines: readonly string[],
  noteQuotes: ReadonlySet<string>,
) {
  const units = answerSentences(view).map((sentence) => ({
    words: folded(sentence.text),
    markers: ownMarkers(sentence.text),
  }));
  const pairs = lines.slice(1).map((line, at) => `${lines[at]} ${line}`);
  const taken = new Map<number, string>();
  const read = records.map((record) => {
    const inNote = noteQuotes.has(record.quote);
    const found = inNote || lines.some((line) => findQuote(line, record.quote) !== null);
    const acrossTwoLines = !found && pairs.some((pair) => findQuote(pair, record.quote) !== null);
    const quote = folded(record.quote);
    const foundFolded =
      !found &&
      !acrossTwoLines &&
      quote !== "" &&
      [...lines, ...pairs].some((text) => folded(text).includes(quote));
    let marker = 0;
    let alreadyHadRecord = false;
    if (found) {
      const words = folded(record.sentence);
      const own =
        units.find((unit) => unit.words === words) ??
        units.find(
          (unit) =>
            words !== "" &&
            unit.words !== "" &&
            (unit.words.includes(words) || words.includes(unit.words)),
        );
      const orphan = own?.markers.find((each) => !taken.has(each));
      if (own?.markers.some((each) => taken.get(each) === record.quote)) alreadyHadRecord = true;
      else if (orphan !== undefined) {
        marker = orphan;
        taken.set(orphan, record.quote);
      } else alreadyHadRecord = own !== undefined;
    }
    return {
      marker,
      alreadyHadRecord,
      found,
      inNote,
      acrossTwoLines,
      foundFolded,
      longestShare: Math.max(0, ...lines.map((line) => longestShare(record.quote, line))),
    };
  });
  return { read, taken };
}

/** Per try: the note and the ask's records in counts, never a word. */
const notes: unknown[] = [];

/** Read only when the proof is asked for: the unit suite imports this file with no arguments. */
const ARGS = ARM ? argumentsOf() : null;

describe.skipIf(!ARGS)("the ask for a fill's records, on a real model (#3099)", () => {
  if (!ARGS) return;
  const args = ARGS;
  mkdirSync(args.out, { recursive: true });
  const fills = picked(savedFills(args.runs), args.arm);
  const fixtures = JSON.parse(
    readFileSync("tests/fixtures/meetings/fill-structured-reserved.json", "utf8"),
  ) as {
    id: string;
    language: Language;
    notes: Parameters<typeof writeMind>[1];
    turns: { side: "me" | "them"; text: string }[];
  }[];
  const spentBefore = (): number => {
    try {
      const spent = JSON.parse(readFileSync(join(args.out, SPEND_FILE), "utf8")) as Record<
        string,
        number
      >;
      return Object.entries(spent)
        .filter(([arm]) => arm !== args.arm)
        .reduce((sum, [, usd]) => sum + usd, 0);
    } catch {
      return 0;
    }
  };
  const dryRequests: { arm: string; case: string; bytes: number; sha256: string; usd: number }[] =
    [];

  test("the arm's fills", () => {
    const counts = { en: 0, "zh-CN": 0 };
    for (const fill of fills) counts[fill.language]++;
    console.log(`Arm ${args.arm}: ${fills.length} fills (en ${counts.en}, zh ${counts["zh-CN"]})`);
    expect(fills.length).toBe(6);
  });

  for (const [index, fill] of fills.entries()) {
    for (let attempt = 1; attempt <= args.tries; attempt++) {
      test(`case ${index + 1}, try ${attempt}`, { timeout: 300_000 }, async () => {
        const call = fixtures.find((each) => each.id === fill.call);
        if (!call) throw new Error(`No fixture for case ${index + 1}.`);
        const { text: reply, own } = firstReply(fill);
        const ledger = createRequestLedger({ model: args.model, price: args.price });
        const seconds: number[] = [];
        let view = "";
        const warnings: { event: string; fields?: LogFields }[] = [];
        let estimated = 0;
        const restore = globalThis.fetch;
        if (DRY) {
          globalThis.fetch = async (input, init) => {
            const body = await new Request(input, init).text();
            const usd = estimated;
            dryRequests.push({
              arm: args.arm,
              case: fill.call,
              bytes: Buffer.byteLength(body),
              sha256: createHash("sha256").update(body).digest("hex"),
              usd,
            });
            return new Response(
              JSON.stringify({ error: { message: "dry run: nothing is sent" } }),
              {
                status: 503,
                headers: { "content-type": "application/json" },
              },
            );
          };
        }
        let given = false;
        const replay = scriptedModel((each): ScriptedReply => {
          if (each.question !== undefined || given) {
            throw new Error("A request other than the fill's first or its ask.");
          }
          given = true;
          return { text: reply };
        });
        const ownQuotes = new Map(own.map((each) => [each.marker, each.quote]));
        const selfAsk = scriptedModel((each): ScriptedReply => {
          if (each.question !== "unmarked-quotes") {
            throw new Error("The self-check scripts only the ask.");
          }
          const answer = /<answer>\n([\s\S]*?)\n<\/answer>/.exec(each.prompt)?.[1] ?? "";
          const passages = [
            ...each.prompt.matchAll(/<passage id="([^"]+)">\n([\s\S]*?)\n<\/passage>/g),
          ].map((match) => ({ id: match[1] ?? "", text: match[2] ?? "" }));
          const quotes =
            SELFCHECK === "every"
              ? everyQuotes(answer, passages, fill.cues)
              : SELFCHECK === "footnotes"
                ? footnoteQuotes(reply)
                : SELFCHECK === "none"
                  ? new Map<number, string>()
                  : ownQuotes;
          const move =
            SELFCHECK === "moved" && index === 0
              ? (marker: number, quote: string) => {
                  if (movedMarkers.length > 0) return null;
                  const next = fill.cues
                    .slice(lineOf(fill.cues, quote) + 1)
                    .map((cue) => cue.text.trim())
                    .find((text) => text !== "" && passages.some((p) => p.text.includes(text)));
                  if (next === undefined) return null;
                  movedMarkers.push(`${fill.call}\t${marker}`);
                  return next;
                }
              : null;
          return {
            text: JSON.stringify({
              citations: scriptedRecords(answer, passages, quotes, move, SELFCHECK === "every"),
            }),
          };
        }, SCRIPTED_USAGE);
        const createChatModel = (spec: Parameters<typeof chatModels.createAiSdkChatModel>[0]) => {
          const real = ledger.model(spec, () =>
            SELFCHECK ? selfAsk : chatModels.createAiSdkChatModel(spec),
          );
          const hybrid: LanguageModelV4 = {
            specificationVersion: real.specificationVersion,
            provider: real.provider,
            modelId: real.modelId,
            supportedUrls: real.supportedUrls,
            doGenerate: (options) => replay.doGenerate(options),
            doStream: async (options) => {
              if (questionOf(options) !== "unmarked-quotes") return replay.doStream(options);
              view = /<answer>\n([\s\S]*?)\n<\/answer>/.exec(promptText(options.prompt))?.[1] ?? "";
              const input = estimateTokens(JSON.stringify(options.prompt));
              const output = options.maxOutputTokens ?? 8_000;
              estimated = inCurrency(
                costOf({ inputTokens: input, outputTokens: output }, args.price, new Date()),
                args.price.currency,
                "USD",
              );
              const spent = spentBefore() + ledger.snapshot().total_usd;
              if (args.sent && spent + estimated > CAP_USD) {
                stoppedAtCap = true;
                throw new Error("The next request could pass the spend cap: not sent.");
              }
              const started = performance.now();
              const result = await real.doStream(options);
              return {
                ...result,
                stream: result.stream.pipeThrough(
                  new TransformStream({
                    flush() {
                      seconds.push((performance.now() - started) / 1000);
                    },
                  }),
                ),
              };
            },
          };
          return hybrid;
        };
        const { core, record } = await transcribingCore(await createTempDataFolder(), {
          engine: {
            lines: ["", ...call.turns.filter((turn) => turn.side === "me").map((t) => t.text)],
            theirLines: [
              "",
              ...call.turns.filter((turn) => turn.side === "them").map((t) => t.text),
            ],
          },
          createChatModel,
          log: {
            info: () => undefined,
            warn: (event, fields) => warnings.push({ event, ...(fields && { fields }) }),
            error: () => undefined,
          },
        });
        try {
          if (stoppedAtCap) throw new Error("Stopped at the spend cap: this try is not run.");
          await core.saveLibrarySettings({
            ...(await core.getLibrary()).settings,
            automatic: false,
          });
          await core.updateSettings({
            user: { language: call.language, monthlyCap: { amount: CAP_USD, currency: "USD" } },
          });
          await core.saveChatProvider({
            kind: args.provider,
            apiKey: args.key,
            modelId: args.model,
          });
          const meeting = await core.createMeeting();
          const client = await connectToMind(core, meeting.mindId);
          if (call.notes.length > 0) writeMind(client, call.notes);
          await client.settled();
          await core.startMeeting({ meetingId: meeting.id, systemAudio: true });
          record(20);
          for (const turn of call.turns) {
            record(2_000, [turn.side === "me" ? "microphone" : "system"]);
            await new Promise((resolve) => setTimeout(resolve, 200));
          }
          await core.stopMeeting(meeting.id);
          const fillNow = await settled(core, meeting);
          const snapshot = ledger.snapshot();
          const units = aiUnits(readMind(client));
          const { facts, overview } = closedFacts(reply);
          const said = new Set([...facts, ...(overview ? [overview] : [])].map((f) => f.sentence));
          const reference = (key: "above" | "below") =>
            new RegExp(
              `^${translate(call.language, `meetings.fill.reference.${key}`, { topic: "\u0000" })
                .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
                .replace("\u0000", ".+")}$`,
              "u",
            );
          const pointers = [reference("above"), reference("below")];
          const sentences = units.filter((unit) => !pointers.some((each) => each.test(unit.text)));
          const writtenFacts = facts.filter((fact) =>
            units.some((unit) => unit.text === fact.sentence),
          );
          const writtenOverview =
            overview && units.some((unit) => unit.text === overview.sentence) ? [overview] : [];
          const askedReply = snapshot.requests.find((each) => each.text.trim() !== "")?.text ?? "";
          const askedList = (() => {
            try {
              const list = (
                JSON.parse(askedReply.replace(/^```(?:json)?|```$/gm, "")) as {
                  citations?: unknown;
                }
              ).citations;
              return Array.isArray(list) ? (list as unknown[]) : [];
            } catch {
              return [];
            }
          })();
          const askedItems = askedList.length;
          const quotes = new Set(
            sentences.flatMap((unit) => unit.citations.map((each) => each.quote)),
          );
          const askedRecords = askedList.flatMap((each) => {
            const { sentence, quote } = (each ?? {}) as { sentence?: unknown; quote?: unknown };
            return typeof sentence === "string" && typeof quote === "string"
              ? [{ sentence, quote }]
              : [];
          });
          const foundQuotes = new Set(
            units.flatMap((unit) =>
              unit.citations.filter((each) => each.check === "found").map((each) => each.quote),
            ),
          );
          const records = readRecords(
            view,
            askedRecords,
            fill.cues.map((cue) => cue.text),
            foundQuotes,
          );
          const omittedByKind = Object.fromEntries(
            warnings
              .filter(
                (each) =>
                  each.event === "meeting.fillItemsOmitted" ||
                  each.event === "meeting.fillInvalidFrames",
              )
              .flatMap((each) =>
                Object.entries(each.fields ?? {}).filter(
                  ([kind, count]) =>
                    typeof count === "number" && kind !== "items" && kind !== "meetingId",
                ),
              ),
          );
          notes.push({
            fill: index + 1,
            try: attempt,
            omittedByKind,
            facts: facts.map((fact) => {
              const markers = new Set(fact.markers);
              return {
                markers: markers.size,
                markersWithRecord: [...markers].filter((marker) => records.taken.has(marker))
                  .length,
                inNote: units.some((unit) => folded(unit.text) === folded(fact.sentence)),
                sentenceKept: units.some((unit) => unit.text === fact.sentence),
              };
            }),
            records: records.read,
          });
          // Each marker once, where it is first written: a marker reused in another fact is the
          // same record.
          const compare = (theirs: ReadonlyMap<number, string>) => {
            let compared = 0;
            let same = 0;
            const seen = new Set<number>();
            for (const fact of [...writtenFacts, ...writtenOverview]) {
              const unit = units.find((each) => each.text === fact.sentence);
              fact.markers.forEach((marker, at) => {
                const mine = theirs.get(marker);
                const asked = unit?.citations[at]?.quote;
                if (mine === undefined || asked === undefined || seen.has(marker)) return;
                seen.add(marker);
                compared++;
                const ownLine = lineOf(fill.cues, mine);
                const askedLine = lineOf(fill.cues, asked);
                if (ownLine === askedLine) same++;
                else if (args.arm === "C")
                  otherLines.push(`${fill.call}\t${marker}\t${ownLine}\t${askedLine}`);
              });
            }
            return { compared, same };
          };
          const ownLines = compare(new Map(own.map((each) => [each.marker, each.quote])));
          const footnotes = compare(footnoteQuotes(reply));
          const usage = snapshot.requests;
          const voided =
            usage.length !== 1
              ? `${usage.length} requests sent`
              : usage.some((each) => each.status !== "completed" || !each.usage_complete)
                ? "a request not completed, or without its usage"
                : null;
          const filled =
            fillNow.state === "filled" &&
            (facts.length > 1 || (writtenFacts.length === 1 && isPartialMeetingFill(fillNow)));
          results.push({
            arm: args.arm,
            fill: index + 1,
            case: fill.call,
            language: call.language,
            try: attempt,
            void: DRY ? "dry run" : voided || "no",
            filled,
            closed: facts.length,
            written: writtenFacts.length,
            sameSentences: sentences.every((unit) => said.has(unit.text)),
            quotesFound: sentences.every((unit) =>
              unit.citations.every(
                (each) => each.check === "found" && lineOf(fill.cues, each.quote) >= 0,
              ),
            ),
            partial: isPartialMeetingFill(fillNow),
            asked: askedItems,
            dropped: records.read.filter((each) => !each.found).length,
            beyondNoteQuotes: Math.max(0, askedItems - quotes.size),
            ownCompared: ownLines.compared,
            sameLine: ownLines.same,
            footnoteCompared: footnotes.compared,
            footnoteSame: footnotes.same,
            seconds: seconds[0] ?? 0,
            usd: snapshot.total_usd,
            sentAt: snapshot.requests.map((each) => each.priced_at),
          });
        } finally {
          core.close();
          globalThis.fetch = restore;
        }
      });
    }
  }

  afterAll(() => {
    if (results.length === 0) return;
    const columns = (Object.keys(results[0] ?? {}) as (keyof Try)[]).filter(
      (column) => column !== "sentAt",
    );
    const rows = results.map((row) => columns.map((column) => String(row[column])));
    const empty = rows.some((row) => row.some((cell) => cell.trim() === ""));
    writeFileSync(
      join(args.out, `arm-${args.arm}.tsv`),
      [columns.join("\t"), ...rows.map((row) => row.join("\t"))].join("\n"),
    );
    if (args.arm === "C") writeFileSync(join(args.out, "other-line.tsv"), otherLines.join("\n"));
    if (SELFCHECK === "moved") writeFileSync(join(args.out, "moved.tsv"), movedMarkers.join("\n"));
    writeFileSync(
      join(args.out, `notes-${args.arm}.jsonl`),
      notes.map((each) => JSON.stringify(each)).join("\n"),
    );
    if (DRY) {
      writeFileSync(
        join(args.out, `dry-${args.arm}.jsonl`),
        dryRequests.map((each) => JSON.stringify(each)).join("\n"),
      );
    }
    let spent: Record<string, number> = {};
    try {
      spent = JSON.parse(readFileSync(join(args.out, SPEND_FILE), "utf8"));
    } catch {
      spent = {};
    }
    spent[args.arm] = results.reduce((sum, row) => sum + row.usd, 0);
    if (args.sent) writeFileSync(join(args.out, SPEND_FILE), JSON.stringify(spent));
    const summary = summarize(args.arm, results, dryRequests);
    writeFileSync(join(args.out, `summary-${args.arm}.json`), JSON.stringify(summary, null, 2));
    console.log(JSON.stringify(summary, null, 2));
    // An empty cell or field is a fault of the harness, and fails the run.
    const blank = (value: unknown): boolean =>
      value === null ||
      value === undefined ||
      (typeof value === "string" && value.trim() === "") ||
      (typeof value === "object" && Object.values(value).some(blank));
    if (empty || blank(summary)) throw new Error("An empty cell or field in the proof's output.");
    if (summary.errors.length > 0) {
      throw new Error(`The proof's score counted nothing in: ${summary.errors.join(", ")}.`);
    }
    if (SELFCHECK) {
      const findings = selfCheckFindings(summary);
      console.log(
        `Self-check "${SELFCHECK}": ${findings.length === 0 ? "as expected" : findings.join("; ")}`,
      );
      if (findings.length > 0) throw new Error(`The self-check "${SELFCHECK}" fell short.`);
    }
  });
});

function summarize(arm: string, rows: readonly Try[], dry: readonly { usd: number }[]) {
  const byLanguage = (pick: (row: Try) => number) => ({
    en: rows.filter((row) => row.language === "en").reduce((sum, row) => sum + pick(row), 0),
    zh: rows.filter((row) => row.language === "zh-CN").reduce((sum, row) => sum + pick(row), 0),
    all: rows.reduce((sum, row) => sum + pick(row), 0),
  });
  const counted = (row: Try) => row.void === "no";
  const filled = (row: Try) => (counted(row) && row.filled ? 1 : 0);
  const median = (values: number[]) => {
    const sorted = [...values].sort((a, b) => a - b);
    return sorted.length === 0 ? 0 : (sorted[Math.floor((sorted.length - 1) / 2)] ?? 0);
  };
  const cases = [...new Set(rows.map((row) => row.fill))];
  const filledRows = rows.filter((row) => filled(row) === 1);
  const asked = byLanguage((row) => (counted(row) ? row.ownCompared : 0));
  const same = byLanguage((row) => (counted(row) ? row.sameLine : 0));
  const closed = byLanguage((row) => row.closed);
  const written = byLanguage((row) => (counted(row) ? row.written : 0));
  // A bar says what it counted, and over a cell with nothing in it it is an error, never held.
  const verdict = (held: boolean, counted: string, empty: string | null) =>
    empty !== null ? `error: ${empty} (${counted})` : `${held ? "held" : "failed"}: ${counted}`;
  const tries = rows.length;
  const filledTries = byLanguage(filled).all;
  const casesTwice = cases.filter(
    (each) => rows.filter((row) => row.fill === each && filled(row)).length >= 2,
  ).length;
  const kept = filledRows.filter((row) => row.sameSentences && row.quotesFound).length;
  const bars =
    arm === "A"
      ? {
          "1: filled in at least 16 of 18, each case in at least 2 of 3": verdict(
            filledTries >= 16 && casesTwice === cases.length,
            `${filledTries} of ${tries} tries filled; ${casesTwice} of ${cases.length} cases filled in at least 2 of 3`,
            tries === 0 ? "no try" : null,
          ),
          "2: every filled try keeps the first reply's sentences, every quote found": verdict(
            kept === filledRows.length,
            `${kept} of ${filledRows.length} filled tries`,
            filledRows.length === 0 ? "no filled try to read" : null,
          ),
          "3: at least 9 in 10 of the closed facts written": verdict(
            written.all >= 0.9 * closed.all,
            `${written.all} of ${closed.all} closed facts written, ${Math.ceil(0.9 * closed.all)} needed`,
            closed.all === 0 ? "no closed fact" : null,
          ),
        }
      : arm === "C"
        ? {
            "4: filled in at least 5 of 6, and 9 in 10 asked markers on the reply's own line":
              verdict(
                filledTries >= 5 && same.all >= 0.9 * asked.all,
                `${filledTries} of ${tries} tries filled; ${same.all} of ${asked.all} asked markers on the reply's own line, ${Math.ceil(0.9 * asked.all)} needed`,
                tries === 0
                  ? "no try"
                  : filledTries >= 5 && asked.all === 0
                    ? "no asked marker to compare"
                    : null,
              ),
          }
        : {
            "B: reported, gates nothing": `reported: ${filledTries} of ${tries} tries filled`,
          };
  const sentAt = rows.flatMap((row) => row.sentAt).sort();
  const hour = (at: string | undefined) => (at ? `${at.slice(0, 13)}:00Z` : "none sent");
  // What each result was counted over; on a real record, a cell that counted nothing is an error.
  const cells = {
    tries: tries,
    closedFacts: closed.all,
    askedMarkers:
      arm === "C" ? asked.all : rows.reduce((sum, row) => sum + (counted(row) ? row.asked : 0), 0),
  };
  const errors =
    DRY || SELFCHECK
      ? []
      : Object.entries(cells)
          .filter(([, count]) => count === 0)
          .map(([cell]) => cell);
  return {
    arm,
    dry: DRY,
    selfCheck: SELFCHECK ?? "no",
    cells,
    errors,
    firstRequestUtcHour: hour(sentAt[0]),
    lastRequestUtcHour: hour(sentAt.at(-1)),
    tries: byLanguage(() => 1),
    void: byLanguage((row) => (counted(row) ? 0 : 1)),
    filled: byLanguage(filled),
    sameSentences: byLanguage((row) => (filled(row) && row.sameSentences ? 1 : 0)),
    quotesFound: byLanguage((row) => (filled(row) && row.quotesFound ? 1 : 0)),
    droppedRecords: byLanguage((row) => (counted(row) ? row.dropped : 0)),
    recordsBeyondNoteQuotes: byLanguage((row) => (counted(row) ? row.beyondNoteQuotes : 0)),
    closedFacts: closed,
    writtenFacts: written,
    askedMarkersCompared: asked,
    askedMarkersOnOwnLine: same,
    footnoteQuotesCompared: byLanguage((row) => row.footnoteCompared),
    footnoteQuotesOnSameLine: byLanguage((row) => row.footnoteSame),
    secondsAdded: {
      median: median(rows.filter(counted).map((row) => row.seconds)),
      longest: Math.max(0, ...rows.filter(counted).map((row) => row.seconds)),
    },
    usd: byLanguage((row) => row.usd),
    dryRequests: dry.length,
    dryEstimateUsd: dry.reduce((sum, each) => sum + each.usd, 0),
    stoppedAtCap,
    bars: Object.fromEntries(
      Object.entries(bars).map(([bar, read]) => [bar, DRY ? "not read in a dry run" : read]),
    ),
  };
}

type Summary = ReturnType<typeof summarize>;

/** What a self-check mode must give, each shortfall with the numbers it read. */
function selfCheckFindings(summary: Summary): string[] {
  const findings: string[] = [];
  const need = (ok: boolean, what: string) => {
    if (!ok) findings.push(what);
  };
  const bar = Object.values(summary.bars)[0] ?? "";
  const { filled, tries, askedMarkersCompared: asked, askedMarkersOnOwnLine: same } = summary;
  if (SELFCHECK === "own") {
    need(filled.all === tries.all, `filled ${filled.all} of ${tries.all}`);
    need(
      asked.all > 0 && same.all === asked.all,
      `${same.all} of ${asked.all} markers on their own line`,
    );
    need(
      summary.sameSentences.all === tries.all,
      `${summary.sameSentences.all} tries keep every sentence`,
    );
    need(
      summary.writtenFacts.all === summary.closedFacts.all,
      `${summary.writtenFacts.all} of ${summary.closedFacts.all} closed facts written`,
    );
    need(otherLines.length === 0, `${otherLines.length} markers on another line`);
    need(bar.startsWith("held"), `bar 4: ${bar}`);
  } else if (SELFCHECK === "moved") {
    need(movedMarkers.length === 1, `${movedMarkers.length} markers moved`);
    need(
      otherLines.length === 1 && otherLines[0]?.startsWith(movedMarkers[0] ?? "-") === true,
      `${otherLines.length} markers listed on another line, the moved one ${otherLines.some((line) => line.startsWith(movedMarkers[0] ?? "-")) ? "among them" : "not among them"}`,
    );
    need(
      asked.all > 0 && same.all === asked.all - 1,
      `${same.all} of ${asked.all} markers on their own line`,
    );
  } else if (SELFCHECK === "none") {
    need(filled.all === 0, `filled ${filled.all} of ${tries.all}`);
    need(bar.startsWith("failed"), `bar 4: ${bar}`);
  } else if (SELFCHECK === "footnotes") {
    const cases = results.filter((row) => row.footnoteCompared > 0);
    need(cases.length > 0, "no try compared footnote quotes");
    need(
      cases.every((row) => row.filled && row.footnoteCompared === 13 && row.footnoteSame === 13),
      cases
        .map(
          (row) => `${row.footnoteSame} of ${row.footnoteCompared} footnote quotes on their line`,
        )
        .join(", "),
    );
    need(
      results.filter((row) => row.footnoteCompared === 0).every((row) => !row.filled),
      "a try without footnote records filled",
    );
    need(bar.startsWith("failed"), `bar 1: ${bar}`);
  } else if (SELFCHECK === "every") {
    const { closedFacts: closed, writtenFacts: written } = summary;
    need(tries.all === 6 && filled.all === 6, `filled ${filled.all} of ${tries.all}`);
    need(
      closed.all === 51 && written.all === 51,
      `${written.all} of ${closed.all} closed facts written`,
    );
    need(summary.sameSentences.all === 6, `${summary.sameSentences.all} tries keep every sentence`);
    need(summary.quotesFound.all === 6, `${summary.quotesFound.all} tries find every quote`);
    need(summary.droppedRecords.all === 0, `${summary.droppedRecords.all} records dropped`);
    const second = results.filter((row) => row.closed === 1);
    need(
      second.length === 1 && second.every((row) => row.filled && row.partial && row.written === 1),
      "the second-frame fill isn't partly filled with its one fact",
    );
  }
  return findings;
}

async function settled(core: Core, meeting: Meeting): Promise<MeetingFill> {
  return vi.waitFor(
    async () => {
      const fill = (await core.listMeetings()).find((each) => each.id === meeting.id)?.fill;
      if (!fill || fill.state === "waiting" || fill.state === "filling") {
        throw new Error(`Not yet: ${fill?.state}`);
      }
      return fill;
    },
    { timeout: 240_000, interval: 250 },
  );
}
