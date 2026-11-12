/**
 * Each Document of a split as Organize reads it (#2737): its name, and its outline and the
 * beginning of its text from `organizeExcerpt`, which the plan cuts shorter. A scan has no text.
 */
import { organizeExcerpt } from "../../../src/core/library/excerpt";
import { prepare } from "./prepare";
import { readSet, type Split } from "./set";

export interface DocumentText {
  id: string;
  language: string;
  name: string;
  text: string;
  scanned: boolean;
  /** The starter Folder it is labelled with, which is a scan's area. */
  label: string | null;
}

export async function documentTexts(root: string, split: Split): Promise<DocumentText[]> {
  const set = await readSet(root);
  const out: DocumentText[] = [];
  for (const doc of set.documents.filter((each) => each.split === split)) {
    const prepared = await prepare(root, doc);
    const excerpt = organizeExcerpt(prepared.source);
    out.push({
      id: doc.id,
      language: doc.language,
      name: excerpt.name,
      text: excerpt.outline ? `${excerpt.outline}\n\n${excerpt.text}` : excerpt.text,
      scanned: prepared.noText,
      label: doc.folder,
    });
  }
  return out;
}
