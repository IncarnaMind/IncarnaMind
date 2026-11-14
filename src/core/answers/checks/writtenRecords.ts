/**
 * The Citation records a check's reply writes into its own text instead of calling `cite`, taken
 * before the check asks for them again (#3019). Claude Haiku 5.5 wrote its records so in about
 * three check runs in five, and the ask that followed lost most of them: it took "Missing Citation
 * markers: [1]" for a paper's own reference [1].
 *
 * Only a record line is read, in the forms such replies take: "[^1]: Tides, p. 4 — “…”",
 * "Cite 1: Tides, p. 4, quote "…"", "[^1] Passage P2, p. 4: "…"", "- marker 1: passage P2, location
 * "p. 4", quote "…"", or a cite call written out as JSON or as code. A quote in running prose is
 * none. A record is taken only as a `cite` call's would be: its quote found by the Citation check in the
 * Passage it names, or in a Passage of the Document it names, on the page it names; never one
 * whose quote only repeats the sentence. Every record asked for is taken, or none, and then the
 * ask goes out as before. Taking a record never changes the verdict the reply gave.
 */
import type { Citation } from "../../api";
import { isRecord } from "../../errors";
import type { createCitationSession } from "../citations";
import type { CitationRecordInput } from "../engine";
import { withoutThinking } from "../judge";

type Session = ReturnType<typeof createCitationSession>;

interface WrittenRecord {
  marker: number;
  passage: string | null;
  document: string | null;
  location: string | null;
  quote: string;
}

const LINE_START = /^[\s>*_#`•-]*/u;
const HEADING =
  /^(?:citations?(?: for the record)?|cite(?: markers?(?: used)?)?|records?)\s*[:：]\s*[-*•]?\s*/iu;
const LABEL =
  /(?:\[\^(\d{1,3})\]\s*[:：]?|\[(\d{1,3})\](?=\s*(?:passage\s+)?P\d)|\b(?:marker|cite|citation)\s+(\d{1,3})\b\s*[:：]?)/giu;
const QUOTED = /“([^”]+)”|"([^"]+)"/gu;
const PASSAGE = /\b(?:passage\s+)?(P\d{1,4})\b/iu;
const PAGE = /\bpp?\.\s*(\d{1,4})(?:\s*[–-]\s*(\d{1,4}))?/iu;
const JSON_RECORDS =
  /"citations"\s*:\s*(\[[\s\S]*?\])\s*[}<]|<parameter name="citations">\s*(\[[\s\S]*?\])\s*<\/parameter>|\bcite\s*\(\s*citations\s*=\s*(\[[\s\S]*?\])\s*\)/gu;

const loose = (text: string) =>
  text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

const pages = (from: string | undefined, to: string | undefined) =>
  to ? `pp. ${from}–${to}` : `p. ${from}`;

function fromLine(line: string): WrittenRecord[] {
  let text = line.replace(LINE_START, "");
  for (let heading = HEADING.exec(text); heading; heading = HEADING.exec(text))
    text = text.slice(heading[0].length).replace(LINE_START, "");
  const labels = [...text.matchAll(LABEL)];
  if (labels.length === 0 || labels[0]?.index !== 0) return [];
  return labels.flatMap((label, index): WrittenRecord[] => {
    const marker = Number(label[1] ?? label[2] ?? label[3]);
    const end = labels[index + 1]?.index ?? text.length;
    // A location given in quotation marks ("location "p. 4"") is no quote.
    const body = text
      .slice((label.index ?? 0) + label[0].length, end)
      .replace(
        /\blocation\s*[:=]?\s*(?:“([^”]*)”|"([^"]*)")/iu,
        (_: string, curly: string | undefined, straight: string | undefined) =>
          `location ${curly ?? straight ?? ""}`,
      );
    const quotes = [...body.matchAll(QUOTED)];
    const [quoted] = quotes;
    if (quotes.length !== 1 || quoted === undefined) return [];
    const quote = (quoted[1] ?? quoted[2] ?? "").trim();
    const before = body.slice(0, quoted.index).replace(/\bquote\b\s*$/iu, "");
    const page = PAGE.exec(before);
    const passage = PASSAGE.exec(before)?.[1]?.toUpperCase() ?? null;
    const named = before
      .replace(/^[\s(（]+/u, "")
      .split(/[,，(（:：·—–]|\bp{1,2}\.|\bpage\b/iu)[0]
      ?.trim();
    return quote === ""
      ? []
      : [
          {
            marker,
            passage,
            document: passage === null && named ? named : null,
            location: page ? pages(page[1], page[2]) : null,
            quote,
          },
        ];
  });
}

function fromJson(reply: string): WrittenRecord[] {
  return [...reply.matchAll(JSON_RECORDS)].flatMap((match) => {
    let given: unknown;
    try {
      given = JSON.parse(match[1] ?? match[2] ?? match[3] ?? "");
    } catch {
      return [];
    }
    return (Array.isArray(given) ? given : []).flatMap((each): WrittenRecord[] => {
      if (!isRecord(each)) return [];
      const { marker, passage, location, quote, pageFrom, pageTo } = each;
      if (typeof marker !== "number" || typeof quote !== "string" || quote.trim() === "") return [];
      const id =
        typeof passage === "string" ? PASSAGE.exec(passage)?.[1]?.toUpperCase() : undefined;
      if (!id) return [];
      const page = typeof location === "string" ? PAGE.exec(location) : null;
      const from = typeof pageFrom === "number" ? String(pageFrom) : undefined;
      const to = typeof pageTo === "number" && pageTo !== pageFrom ? String(pageTo) : undefined;
      return [
        {
          marker,
          passage: id,
          document: null,
          location: page ? pages(page[1], page[2]) : from ? pages(from, to) : null,
          quote: quote.trim(),
        },
      ];
    });
  });
}

/** The records a reply writes into its text, each once, in order. */
export function writtenRecords(reply: string): WrittenRecord[] {
  const text = withoutThinking(reply);
  const records = [...text.split("\n").flatMap(fromLine), ...fromJson(text)];
  const seen = new Set<string>();
  return records.filter((record) => {
    const key = JSON.stringify(record);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Whether `name` names the Document `documentName`: the same words, or its first ones. */
function names(name: string, documentName: string): boolean {
  const given = loose(name);
  const full = loose(documentName.replace(/\.[a-z0-9]{2,5}$/iu, ""));
  return given !== "" && (full === given || full.startsWith(`${given} `));
}

/** The Passage the Citation check finds `record`'s quote in, as a `cite` call would name it. */
function foundIn(record: WrittenRecord, session: Session): CitationRecordInput | null {
  const shown = session.shownPassages().map((each) => each.id);
  const candidates = record.passage
    ? shown.filter((id) => id === record.passage)
    : record.document
      ? shown
      : [];
  const matches: { input: CitationRecordInput; document: string }[] = [];
  for (const passage of candidates) {
    const input = {
      marker: record.marker,
      passage,
      location: record.location,
      quote: record.quote,
    };
    const quoted = session.quotes.quote(input);
    if ("problem" in quoted || quoted.check().check !== "found") continue;
    matches.push({ input, document: quoted.citation.documentName });
  }
  const named = record.document;
  const inNamed = named ? matches.filter((each) => names(named, each.document)) : matches;
  // A name that fits the quote's Documents more than one way names none of them.
  if (named && new Set(inNamed.map((each) => each.document)).size > 1) return null;
  return inNamed[0]?.input ?? null;
}

/**
 * The records `reply` wrote for `markers` (for none, the one record it wrote, as `marker`), cited
 * in `session` when the Citation check finds every one of them; null, with nothing cited, when it
 * doesn't. The sentence is `claim`: a record whose quote only repeats it is none.
 */
export function takeWrittenRecords(
  reply: string,
  markers: readonly number[],
  claim: string,
  session: Session,
  marker: number,
): Citation[] | null {
  const records = writtenRecords(reply).filter((record) => loose(record.quote) !== loose(claim));
  const only = records.length === 1 ? records[0] : undefined;
  const wanted =
    markers.length > 0
      ? markers.map((each) => {
          const given = records.filter((record) => record.marker === each);
          return given.length === 1 ? given[0] : undefined;
        })
      : [only && { ...only, marker }];
  const inputs: CitationRecordInput[] = [];
  for (const record of wanted) {
    const input = record ? foundIn(record, session) : null;
    if (!input) return null;
    inputs.push(input);
  }
  session.tools.cite(inputs, { structured: true });
  session.check();
  const citations = inputs.map((input) => session.finalCitation(input.marker));
  return citations.every((citation) => citation?.check === "found")
    ? citations.filter((citation): citation is Citation => citation !== null)
    : null;
}
