import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { descendants, parseXml } from "../../src/core/documents/formats/xml";
import { openPackage, resolvePart } from "../../src/core/documents/formats/zip";
import { evalCache } from "../lib/cache";
import { countFeatures, type Features } from "./features";

export const WORD_DIR = dirname(fileURLToPath(import.meta.url));

export const DOMAINS = [
  "legal",
  "finance",
  "medical",
  "academic",
  "government",
  "engineering",
  "hr",
  "education",
  "business",
  "test",
] as const;

export const LANGUAGES = [
  "en",
  "zh",
  "zh-TW",
  "ja",
  "ko",
  "de",
  "fr",
  "es",
  "ar",
  "he",
  "mixed",
  "n/a",
] as const;

export interface CorpusEntry {
  /** Relative to eval/word/. */
  file: string;
  set: "documents" | "tracked-changes" | "breadth" | "saved";
  origin: string;
  language: (typeof LANGUAGES)[number];
  domain: (typeof DOMAINS)[number];
  licence: string;
  /** Where the file came from, pinned to a commit; empty for a synthetic file. */
  source: string;
  /** Why the file may be reused, for an official document that has no licence. */
  basis?: string;
  /** What was changed from the published file, when something was. */
  modification?: string;
  originalSha256?: string;
  sha256: string;
  features: Features;
  /** Why the input package is known not to pass inspection, when it is. */
  known?: string;
}

/** A file of the extended set: fetched into a cache, or generated into it, never committed. */
export interface ExtendedEntry {
  /** Relative to the cache folder. */
  name: string;
  kind: "real" | "generated";
  origin: string;
  licence: string;
  source: string;
  /** Where to fetch a real file from, pinned to a commit. */
  url?: string;
  /** Of a real file; a generated one varies with the compressor. */
  sha256?: string;
  language: CorpusEntry["language"];
  domain: CorpusEntry["domain"];
  features: Features;
  /** Why the input package is known not to pass inspection, when it is. */
  known?: string;
}

export function readManifest(): CorpusEntry[] {
  return JSON.parse(readFileSync(join(WORD_DIR, "manifest.json"), "utf8")) as CorpusEntry[];
}

export function readExtended(): ExtendedEntry[] {
  return JSON.parse(readFileSync(join(WORD_DIR, "extended.json"), "utf8")) as ExtendedEntry[];
}

/** Where `npm run eval:word:fetch` puts the extended set. */
export function extendedCache(): string {
  return process.env.INCARNAMIND_WORD_CACHE ?? join(evalCache(), "word-extended");
}

export interface CorpusOutcome {
  ok: boolean;
  detail: string;
  inspectionProblem?: true;
}

export function corpusFailure(
  subject: { name: string; known?: string },
  step: string,
  outcome: Pick<CorpusOutcome, "detail" | "inspectionProblem">,
): { known?: string; failure?: string } {
  const line = `${subject.name}: ${step}: ${outcome.detail}`;
  return step === "package" && outcome.inspectionProblem && subject.known
    ? { known: `  (known: ${subject.known}) ${line}` }
    : { failure: line };
}

export interface PackageReport {
  features: Features;
  /** What would make Word offer to repair the file; empty when nothing does. */
  problems: string[];
}

/**
 * Reads a package the way Word's checks go, in the parts that matter: every XML part is
 * well-formed, every relationship points at a part that exists, and every part has a content type.
 * LibreOffice repairs silently, so this stands in for Word's "found unreadable content" prompt.
 */
export async function inspectPackage(bytes: Uint8Array): Promise<PackageReport> {
  const problems: string[] = [];
  const zip = openPackage(bytes);
  const names = zip.names();
  const parts = new Map<string, string>();
  const known = new Set(names);

  for (const name of names) {
    if (!/\.(?:xml|rels)$/i.test(name)) continue;
    const text = await zip.readText(name);
    if (text === undefined) continue;
    try {
      const root = parseXml(text);
      if ((name.startsWith("word/") && name.endsWith(".xml")) || name === "docProps/app.xml") {
        parts.set(name, text);
      }
      if (name.endsWith(".rels")) {
        const ownerDir = name.slice(0, name.lastIndexOf("_rels/"));
        for (const each of descendants(root, "Relationship")) {
          const target = each.attrs.Target;
          if (!target || each.attrs.TargetMode === "External") continue;
          const resolved = resolvePart(`${ownerDir}owner`, target);
          if (!known.has(resolved)) problems.push(`${name}: ${target} is not in the package`);
        }
      }
    } catch (error) {
      problems.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const types = await zip.readText("[Content_Types].xml");
  if (types === undefined) {
    problems.push("[Content_Types].xml is missing");
  } else {
    const defaults = new Set<string>();
    const overrides = new Set<string>();
    try {
      const root = parseXml(types);
      for (const each of descendants(root, "Default")) {
        if (each.attrs.Extension) defaults.add(each.attrs.Extension.toLowerCase());
      }
      for (const each of descendants(root, "Override")) {
        if (each.attrs.PartName) overrides.add(each.attrs.PartName.slice(1));
      }
    } catch {
      problems.push("[Content_Types].xml is not well-formed");
    }
    for (const name of names) {
      // Word keeps "[trash]/" entries from edits; the packaging rules let them be.
      if (name === "[Content_Types].xml" || name.endsWith("/") || name.startsWith("[trash]/"))
        continue;
      const extension = name.slice(name.lastIndexOf(".") + 1).toLowerCase();
      if (!overrides.has(name) && !defaults.has(extension)) {
        problems.push(`${name}: no content type`);
      }
    }
  }
  if (!known.has("word/document.xml")) problems.push("word/document.xml is missing");
  for (const [name, text] of parts) {
    if (!/^word\/document\d*\.xml$/.test(name)) continue;
    // Word shows "Error! Reference source not found." for a cross-reference to a note whose
    // bookmark isn't there.
    const bookmarks = new Set(
      [...text.matchAll(/<w:bookmarkStart\b[^>]*\bw:name="([^"]*)"/g)].map((m) => m[1]),
    );
    for (const found of text.matchAll(/\bNOTEREF\s+(\S+)/g)) {
      const argument = found[1];
      if (!argument) continue;
      // Word opens a field with no bookmark name and shows its inline error; it offers no
      // repair, and this list stands in for Word's repair prompt.
      if (argument.startsWith("\\")) continue;
      if (!bookmarks.has(argument))
        problems.push(`${name}: NOTEREF ${argument} points at no bookmark`);
    }
  }
  return { features: countFeatures(parts, names), problems };
}

function driftIn(listed: Features, found: Features): string | undefined {
  const keys = Object.keys(found) as (keyof Features)[];
  const wrong = keys.filter((key) => JSON.stringify(listed[key]) !== JSON.stringify(found[key]));
  return wrong.length > 0 ? wrong.join(", ") : undefined;
}

export async function checkInputPackage(
  bytes: Uint8Array,
  listed: Features,
): Promise<CorpusOutcome> {
  const { features, problems } = await inspectPackage(bytes);
  const drift = driftIn(listed, features);
  if (drift) return { ok: false, detail: `its listed features are out of date: ${drift}` };
  return problems.length > 0
    ? { ok: false, detail: problems.slice(0, 3).join("; "), inspectionProblem: true }
    : { ok: true, detail: "" };
}
