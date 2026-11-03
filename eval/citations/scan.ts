/**
 * The scan every published file of the benchmark must pass: no API key, no
 * key this shell holds, no e-mail address, phone number or home folder path,
 * in the set, the runs, the judgements and the results, and no Document but
 * those `documents.json` lists, each with its SHA-256. A Document's own text
 * is read as the app reads it, and a page with no text to read fails until
 * its image has been read and the reading recorded. `scan-allowed.json`
 * records the exceptions: an address a Document's publisher printed there (an
 * author's, a court's press office), named by its SHA-256 and never repeated,
 * and each page read from its image, bound to the Document's SHA-256. Every
 * entry must still match, and the file itself is scanned with no exceptions.
 * A deny-list kept outside the repository adds words no file may hold.
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { loadCitationSet, readDocuments } from "./checkSet";

export type FindingKind =
  | "api-key"
  | "held-key"
  | "email"
  | "phone"
  | "home-path"
  | "unlisted-file"
  | "changed-document"
  | "unread-page"
  | "unused-allowance"
  | "denied-word";

export interface Finding {
  file: string;
  /** From 1; a Document's page for one read through processing. */
  line: number;
  kind: FindingKind;
  /** What was found, with most of it hidden, so the report itself leaks nothing. */
  shown: string;
}

export type Allowed =
  | {
      kind: "email" | "phone";
      /** The SHA-256 of the value as found in the Document. */
      sha256: string;
      document: string;
      why: string;
    }
  | {
      /** A page the scan has no text for, whose image was read instead. */
      kind: "page-read";
      /** The Document's SHA-256 when it was read, so a changed file is read again. */
      sha256: string;
      document: string;
      page: number;
      why: string;
    };

type AllowedValue = (kind: "email" | "phone", sha256: string) => boolean;

export const ALLOWED_FILE = "eval/citations/scan-allowed.json";

/** Keys by the shapes their services give them. A bare "sk-" key (DeepSeek, Kimi and others) needs 32 characters after it. */
export const KEY_PATTERNS: readonly RegExp[] = [
  /\bsk-ant-[A-Za-z0-9_-]{20,}/g,
  /\bsk-or-v1-[A-Za-z0-9]{20,}/g,
  /\bsk-(?:proj|svcacct|admin)-[A-Za-z0-9_-]{20,}/g,
  /\bsk-[A-Za-z0-9]{32,}/g,
  /\bAIza[0-9A-Za-z_-]{30,}/g,
  /\bAQ\.[0-9A-Za-z_-]{30,}/g,
  /\bxai-[A-Za-z0-9]{30,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{30,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{40,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  /\bhf_[A-Za-z0-9]{30,}/g,
  /\bgsk_[A-Za-z0-9]{40,}/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/g,
  // An authentication scheme's name is case-insensitive (RFC 9110).
  /\bBearer\s+[A-Za-z0-9._~+/-]{20,}=*/gi,
];

/** Bounded as RFC 5321 bounds an address, so a long unbroken run of letters is read in linear time. */
const EMAIL =
  /[\p{L}\p{N}._%+-]{1,64}@[\p{L}\p{N}-]{1,63}(?:\.[\p{L}\p{N}-]{1,63}){0,126}\.\p{L}{2,63}/gu;

/** International, North American and Chinese mobile numbers, standing on their own. */
const PHONES: readonly RegExp[] = [
  /(?<![\w+])\+\d{1,3}[ .-]?\(?\d{1,4}\)?(?:[ .-]?\d{2,4}){2,4}(?![\w])/g,
  /(?<![\w(])\(\d{3}\)\s?\d{3}[ .-]\d{4}(?!\w)/g,
  /(?<![\w./-])\d{3}[.-]\d{3}[.-]\d{4}(?![\w.-])/g,
  /(?<![\w./=-])1[3-9]\d{9}(?![\w.-])/g,
];

/**
 * A home folder in a path names its owner, also when a tool names a folder
 * after a project's path, its slashes turned into dashes.
 */
const HOME_PATHS: readonly RegExp[] = [
  /(?:\/Users\/|\/home\/|[A-Za-z]:\\Users\\)(?!Shared\b)[^\s/\\"'`]+/g,
  /(?<!\w)-(?:Users|home)-(?!Shared\b)[^\s/\\"'`-]+(?=-|[\s/\\"'`]|$)/g,
];

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

/** "sk-a…(40)": enough to find it, not enough to use it. */
const hidden = (value: string) => `${value.slice(0, 4)}…(${value.length})`;

/**
 * Values the shell holds under a name that says it is a key, a token or a
 * secret ("OPENAI_API_KEY", "KIMI_KEY_2"): none may be in a published file,
 * whatever its shape.
 */
export function heldSecrets(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string[] {
  return Object.entries(env)
    .filter(
      ([name, value]) => /KEY|TOKEN|SECRET|PASSWORD/i.test(name) && (value?.length ?? 0) >= 12,
    )
    .map(([, value]) => value as string);
}

/**
 * The words of a deny-list kept outside the repository, one a line ("#" at a
 * line's start or after a space starts a comment), which no published file
 * may hold, whatever their case.
 * A list named but missing, empty or inside the repository fails, so the scan
 * never runs without the list it was given.
 */
export function readDenyList(path: string, root: string): string[] {
  const where = relative(resolve(root), resolve(path));
  if (!where.startsWith("..") && !isAbsolute(where)) {
    throw new Error(
      "The deny-list is inside the repository: keep it outside, where nothing publishes it.",
    );
  }
  if (!existsSync(path)) throw new Error(`The deny-list ${path} doesn't exist.`);
  const words = readFileSync(path, "utf8")
    .replace(/^\uFEFF/, "")
    .split(/\r\n|\r|\n/)
    .map((line) => line.replace(/(?:^|\s)#.*$/, "").trim())
    .filter((line) => line !== "");
  if (words.length === 0) throw new Error(`The deny-list ${path} holds no words.`);
  return words;
}

const escaped = (word: string) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A run of escapes as UTF-8; where it isn't, each escape that decodes alone is read and the rest kept as written. */
function decodeRun(run: string): string {
  try {
    return decodeURIComponent(run);
  } catch {
    const escapes = run.match(/%[0-9A-Fa-f]{2}/g) ?? [];
    let decoded = "";
    for (let index = 0; index < escapes.length; ) {
      const lead = Number.parseInt(escapes[index]?.slice(1) ?? "", 16);
      const size = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
      try {
        decoded += decodeURIComponent(escapes.slice(index, index + size).join(""));
        index += size;
      } catch {
        decoded += escapes[index];
        index += 1;
      }
    }
    return decoded;
  }
}

/**
 * Text with its percent-escapes read as a URL's reader gets them ("%40" an
 * "@", "%2F" a "/"). `at` gives each character's place in the text, for its
 * line.
 */
export function decodePercent(text: string): { text: string; at: number[] } {
  let decoded = "";
  const at: number[] = [];
  let from = 0;
  for (const match of text.matchAll(/(?:%[0-9A-Fa-f]{2})+/g)) {
    const start = match.index ?? 0;
    for (let index = from; index < start; index++) {
      decoded += text[index];
      at.push(index);
    }
    const run = decodeRun(match[0]);
    decoded += run;
    for (let index = 0; index < run.length; index++) at.push(start);
    from = start + match[0].length;
  }
  for (let index = from; index < text.length; index++) {
    decoded += text[index];
    at.push(index);
  }
  return { text: decoded, at };
}

/** A path escaped twice ("%252F") is read in two passes; no more, so a scan stays bounded. */
const PERCENT_PASSES = 2;

/**
 * What one text holds that may not be published: in the text as written,
 * and in it with its percent-escapes decoded, once and twice, so decoding
 * only adds findings. `allowed` lets an address or a number through by its
 * SHA-256.
 */
export function scanText(
  raw: string,
  file: string,
  options: {
    allowed?: AllowedValue;
    secrets?: readonly string[];
    /** Words no published file may hold, in any case (`readDenyList`). */
    denied?: readonly string[];
    lineOf?: (index: number) => number;
  } = {},
): Finding[] {
  const allowed: AllowedValue = options.allowed ?? (() => false);
  const lineOf = options.lineOf ?? ((index: number) => raw.slice(0, index).split("\n").length);
  const readings = [{ text: raw, at: (index: number) => index }];
  for (let pass = 0; pass < PERCENT_PASSES; pass++) {
    const last = readings.at(-1) ?? { text: raw, at: (index: number) => index };
    const next = decodePercent(last.text);
    if (next.text === last.text) break;
    readings.push({
      text: next.text,
      at: (index: number) => last.at(next.at[index] ?? last.text.length),
    });
  }
  /** By kind and place in the text as written, so a finding in more than one reading counts once. */
  const findings = new Map<string, Finding>();
  for (const { text, at } of readings) {
    const found = (kind: FindingKind, index: number, shown: string) => {
      const place = at(index);
      const key = `${kind} ${place} ${shown}`;
      if (!findings.has(key)) findings.set(key, { file, line: lineOf(place), kind, shown });
    };
    const add = (kind: FindingKind, value: string, index: number) => {
      if ((kind === "email" || kind === "phone") && allowed(kind, sha256(value))) return;
      found(kind, index, hidden(value));
    };
    for (const pattern of KEY_PATTERNS) {
      for (const match of text.matchAll(pattern)) add("api-key", match[0], match.index ?? 0);
    }
    for (const secret of options.secrets ?? []) {
      const index = text.indexOf(secret);
      if (index >= 0) found("held-key", index, "a key this shell holds");
    }
    for (const match of text.matchAll(EMAIL)) add("email", match[0], match.index ?? 0);
    for (const pattern of PHONES) {
      for (const match of text.matchAll(pattern)) add("phone", match[0], match.index ?? 0);
    }
    for (const pattern of HOME_PATHS) {
      for (const match of text.matchAll(pattern)) add("home-path", match[0], match.index ?? 0);
    }
    for (const word of options.denied ?? []) {
      for (const match of text.matchAll(new RegExp(escaped(word), "giu"))) {
        found("denied-word", match.index ?? 0, "a word on the deny-list");
      }
    }
  }
  return [...findings.values()];
}

const TEXT_FILE = /\.(?:json|jsonl|md|ts|txt|csv)$/i;
const JSON_FILE = /\.jsonl?$/i;

const ESCAPED: Readonly<Record<string, string>> = {
  n: "\n",
  r: "\r",
  t: "\t",
  b: "\b",
  f: "\f",
  '"': '"',
  "\\": "\\",
  "/": "/",
};

/**
 * JSON's text with its escapes read as the characters they stand for, as a
 * reader of the file gets them: "\/" a slash, "\u0040" an "@". `at` gives
 * each character's place in the file, for its line.
 */
export function decodeJsonEscapes(text: string): { text: string; at: number[] } {
  let decoded = "";
  const at: number[] = [];
  for (let index = 0; index < text.length; index++) {
    const char = text[index] as string;
    const next = text[index + 1];
    if (
      char === "\\" &&
      next === "u" &&
      /^[0-9a-fA-F]{4}$/.test(text.slice(index + 2, index + 6))
    ) {
      decoded += String.fromCharCode(Number.parseInt(text.slice(index + 2, index + 6), 16));
      at.push(index);
      index += 5;
    } else if (char === "\\" && next !== undefined && ESCAPED[next] !== undefined) {
      decoded += ESCAPED[next];
      at.push(index);
      index += 1;
    } else {
      decoded += char;
      at.push(index);
    }
  }
  return { text: decoded, at };
}

function filesUnder(folder: string): string[] {
  if (!existsSync(folder)) return [];
  return readdirSync(folder).flatMap((name) => {
    const path = join(folder, name);
    return statSync(path).isDirectory() ? filesUnder(path) : [path];
  });
}

export function readAllowed(root: string): Allowed[] {
  const path = join(root, ALLOWED_FILE);
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as Allowed[]) : [];
}

/** A file's findings: a JSON file read with its escapes decoded, as its reader gets it. */
function scanFile(
  path: string,
  file: string,
  options: { allowed?: AllowedValue; secrets: readonly string[]; denied: readonly string[] },
): Finding[] {
  const text = readFileSync(path, "utf8");
  if (!JSON_FILE.test(path)) return scanText(text, file, options);
  const decoded = decodeJsonEscapes(text);
  const lineOf = (index: number) =>
    text.slice(0, decoded.at[index] ?? text.length).split("\n").length;
  return scanText(decoded.text, file, { ...options, lineOf });
}

/**
 * Scans the set and every run folder: the text files as they are, each listed
 * Document through the app's processing, and every file that isn't text or a
 * listed Document as one that may not be there.
 */
export async function scanBenchmark(
  root: string,
  folders: readonly string[],
  options: { secrets?: readonly string[]; denied?: readonly string[] } = {},
): Promise<Finding[]> {
  const secrets = options.secrets ?? heldSecrets();
  const denied = options.denied ?? [];
  const set = await loadCitationSet(root);
  const allowed = readAllowed(root);
  const used = new Set<Allowed>();
  /** The addresses and numbers a Document really prints and an entry lets through, by kind and SHA-256. */
  const printed = new Set<string>();
  const listed = new Map(set.documents.map((document) => [join(root, document.path), document]));
  const findings: Finding[] = [];
  const shown = (path: string) => relative(root, path);

  for (const [path, document] of listed) {
    const bytes = readFileSync(path);
    if (createHash("sha256").update(bytes).digest("hex") !== document.sha256) {
      findings.push({ file: shown(path), line: 0, kind: "changed-document", shown: document.key });
    }
  }
  const stored = await readDocuments(root, set.documents);
  for (const document of set.documents) {
    const { outcome, units } = stored.get(document.key) ?? { outcome: "missing", units: [] };
    const own = allowed.filter((entry) => entry.document === document.key);
    const withText = new Set(
      units.filter((unit) => unit.text.trim() !== "").map((unit) => unit.page),
    );
    for (let page = 1; page <= document.pages; page++) {
      if (withText.has(page)) continue;
      const read = own.find(
        (entry) =>
          entry.kind === "page-read" && entry.page === page && entry.sha256 === document.sha256,
      );
      if (read) used.add(read);
      else {
        findings.push({
          file: document.path,
          line: page,
          kind: "unread-page",
          shown: outcome === "ready" ? "no text on the page" : `processing gives ${outcome}`,
        });
      }
    }
    const printedHere: AllowedValue = (kind, hash) => {
      const entry = own.find((each) => each.kind === kind && each.sha256 === hash);
      if (!entry) return false;
      used.add(entry);
      printed.add(`${kind} ${hash}`);
      return true;
    };
    for (const unit of units) {
      findings.push(
        ...scanText(unit.text, document.path, {
          allowed: printedHere,
          secrets,
          denied,
          lineOf: () => unit.page ?? 0,
        }),
      );
    }
  }

  const allowedFile = join(root, ALLOWED_FILE);
  if (existsSync(allowedFile))
    findings.push(...scanFile(allowedFile, ALLOWED_FILE, { secrets, denied }));
  allowed.forEach((entry, index) => {
    if (used.has(entry)) return;
    findings.push({
      file: ALLOWED_FILE,
      line: 0,
      kind: "unused-allowance",
      shown: `entry ${index + 1} (${entry.kind}, ${entry.document}) matches nothing in its Document`,
    });
  });

  const asPrinted: AllowedValue = (kind, hash) => printed.has(`${kind} ${hash}`);
  for (const folder of folders) {
    for (const path of filesUnder(folder)) {
      if (path === allowedFile || listed.has(path)) continue;
      if (!TEXT_FILE.test(path)) {
        findings.push({
          file: shown(path),
          line: 0,
          kind: "unlisted-file",
          shown: "not a listed Document",
        });
        continue;
      }
      findings.push(...scanFile(path, shown(path), { allowed: asPrinted, secrets, denied }));
    }
  }
  return findings;
}

export const findingLine = (finding: Finding) =>
  `${finding.file}${finding.line > 0 ? `:${finding.line}` : ""}: ${finding.kind} (${finding.shown})`;
