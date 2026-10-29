/**
 * The scan every published file of the benchmark must pass: no API key, no
 * key this shell holds, no e-mail address, phone number or home folder path,
 * in the set, the runs, the judgements and the results, and no Document but
 * those `documents.json` lists, each with its SHA-256. A Document's own text
 * is read as the app reads it; an address its publisher printed there (an
 * author's, a court's press office) is allowed only by its entry in
 * `scan-allowed.json`, which names it by its SHA-256, says why, and doesn't
 * repeat it.
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { loadCitationSet, readDocuments } from "./checkSet";

export type FindingKind =
  | "api-key"
  | "held-key"
  | "email"
  | "phone"
  | "home-path"
  | "unlisted-file"
  | "changed-document";

export interface Finding {
  file: string;
  /** From 1; a Document's page for one read through processing. */
  line: number;
  kind: FindingKind;
  /** What was found, with most of it hidden, so the report itself leaks nothing. */
  shown: string;
}

export interface Allowed {
  /** The SHA-256 of the value as found. */
  sha256: string;
  kind: "email" | "phone";
  document: string;
  why: string;
}

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
  /\bBearer\s+[A-Za-z0-9._~+/-]{20,}=*/g,
];

const EMAIL = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)*\.\p{L}{2,}/gu;

/** International, North American and Chinese mobile numbers, standing on their own. */
const PHONES: readonly RegExp[] = [
  /(?<![\w+])\+\d{1,3}[ .-]?\(?\d{1,4}\)?(?:[ .-]?\d{2,4}){2,4}(?![\w])/g,
  /(?<![\w(])\(\d{3}\)\s?\d{3}[ .-]\d{4}(?!\w)/g,
  /(?<![\w./-])\d{3}[.-]\d{3}[.-]\d{4}(?![\w.-])/g,
  /(?<![\w./=-])1[3-9]\d{9}(?![\w.-])/g,
];

/** A home folder in a path names its owner. */
const HOME_PATH = /(?:\/Users\/|\/home\/|[A-Za-z]:\\Users\\)(?!Shared\b)[^\s/\\"'`]+/g;

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

/** "sk-a…(40)": enough to find it, not enough to use it. */
const hidden = (value: string) => `${value.slice(0, 4)}…(${value.length})`;

/**
 * Values the shell holds under a name that says it is a key, a token or a
 * secret: none may be in a published file, whatever its shape.
 */
export function heldSecrets(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string[] {
  return Object.entries(env)
    .filter(
      ([name, value]) => /(?:KEY|TOKEN|SECRET|PASSWORD)$/i.test(name) && (value?.length ?? 0) >= 12,
    )
    .map(([, value]) => value as string);
}

/** What one text holds that may not be published; `allowed` lets through values by their SHA-256. */
export function scanText(
  text: string,
  file: string,
  options: {
    allowed?: ReadonlySet<string>;
    secrets?: readonly string[];
    lineOf?: (index: number) => number;
  } = {},
): Finding[] {
  const allowed = options.allowed ?? new Set<string>();
  const lineOf = options.lineOf ?? ((index: number) => text.slice(0, index).split("\n").length);
  const findings: Finding[] = [];
  const add = (kind: FindingKind, value: string, index: number) => {
    if ((kind === "email" || kind === "phone") && allowed.has(sha256(value))) return;
    findings.push({ file, line: lineOf(index), kind, shown: hidden(value) });
  };
  for (const pattern of KEY_PATTERNS) {
    for (const match of text.matchAll(pattern)) add("api-key", match[0], match.index ?? 0);
  }
  for (const secret of options.secrets ?? []) {
    const index = text.indexOf(secret);
    if (index >= 0)
      findings.push({
        file,
        line: lineOf(index),
        kind: "held-key",
        shown: "a key this shell holds",
      });
  }
  for (const match of text.matchAll(EMAIL)) add("email", match[0], match.index ?? 0);
  for (const pattern of PHONES) {
    for (const match of text.matchAll(pattern)) add("phone", match[0], match.index ?? 0);
  }
  for (const match of text.matchAll(HOME_PATH)) add("home-path", match[0], match.index ?? 0);
  return findings;
}

const TEXT_FILE = /\.(?:json|jsonl|md|ts|txt|csv)$/i;

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

/**
 * Scans the set and every run folder: the text files as they are, each listed
 * Document through the app's processing, and every file that isn't text or a
 * listed Document as one that may not be there.
 */
export async function scanBenchmark(
  root: string,
  folders: readonly string[],
  secrets: readonly string[] = heldSecrets(),
): Promise<Finding[]> {
  const set = await loadCitationSet(root);
  const allowed = readAllowed(root);
  const allowedHashes = new Set(allowed.map((entry) => entry.sha256));
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
    const units = stored.get(document.key)?.units ?? [];
    const ownAllowed = new Set(
      allowed.filter((entry) => entry.document === document.key).map((entry) => entry.sha256),
    );
    for (const unit of units) {
      findings.push(
        ...scanText(unit.text, document.path, {
          allowed: ownAllowed,
          secrets,
          lineOf: () => unit.page ?? 0,
        }),
      );
    }
  }

  for (const folder of folders) {
    for (const path of filesUnder(folder)) {
      if (path.endsWith(ALLOWED_FILE)) continue;
      if (listed.has(path)) continue;
      if (!TEXT_FILE.test(path)) {
        findings.push({
          file: shown(path),
          line: 0,
          kind: "unlisted-file",
          shown: "not a listed Document",
        });
        continue;
      }
      const text = readFileSync(path, "utf8");
      if (!/\.jsonl?$/.test(path)) {
        findings.push(...scanText(text, shown(path), { allowed: allowedHashes, secrets }));
        continue;
      }
      const decoded = decodeJsonEscapes(text);
      const lineOf = (index: number) =>
        text.slice(0, decoded.at[index] ?? text.length).split("\n").length;
      findings.push(
        ...scanText(decoded.text, shown(path), { allowed: allowedHashes, secrets, lineOf }),
      );
    }
  }
  return findings;
}

export const findingLine = (finding: Finding) =>
  `${finding.file}${finding.line > 0 ? `:${finding.line}` : ""}: ${finding.kind} (${finding.shown})`;
