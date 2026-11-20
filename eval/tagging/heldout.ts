import { join } from "node:path";
import type { DocumentKind } from "../../src/core/api";
import { isTagKind, type TagKind } from "../../src/core/tags/kinds";
import { prepare } from "../organize/lib/prepare";
import { readSet } from "../organize/lib/set";

export interface SetDocument {
  id: string;
  split: "tune" | "heldout" | "walk";
  language: "en" | "zh";
  topic?: string;
  name: string;
  kind: DocumentKind;
  pageCount: number | null;
  text: string;
  invoice: boolean;
  fits: string[];
  goldKinds?: TagKind[];
}

export async function combinedHeldout(root: string, tagging: readonly SetDocument[]) {
  const directory = join(root, "tests/fixtures/organize-fresh");
  const set = await readSet(root, directory);
  const combined = tagging.filter((doc) => doc.split === "heldout");
  for (const doc of set.documents) {
    const { source } = await prepare(root, doc, directory);
    const goldKinds = doc.tags.map((code) => {
      const kind = code === "notes" ? "meeting-notes" : code;
      if (!isTagKind(kind)) throw new Error(`Unknown gold kind ${kind} on ${doc.id}`);
      return kind;
    });
    combined.push({
      id: doc.id,
      split: "heldout",
      language: doc.language,
      name: source.name,
      kind: doc.kind,
      pageCount: source.pageCount,
      text: source.passages.join("\n\n"),
      invoice: doc.tags.includes("invoice"),
      fits: [],
      goldKinds,
    });
  }
  return combined;
}
