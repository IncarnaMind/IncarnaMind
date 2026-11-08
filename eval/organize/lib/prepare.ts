/** A Document of the set as Organize reads it: extracted by the processing code, as when it is added. */
import { join } from "node:path";
import { nameFromPath } from "../../../src/core/documents/files";
import { runJob } from "../../../src/core/documents/processing";
import { type OrganizeSource, organizeNeedsPageImages } from "../../../src/core/library/excerpt";
import { SET_DIRECTORY, type SetDocument } from "./set";

export interface Prepared {
  doc: SetDocument;
  file: string;
  source: OrganizeSource;
  visual: boolean;
  /** Extraction found no text: only a route that reads page images can organize it. */
  noText: boolean;
}

export async function prepare(
  root: string,
  doc: SetDocument,
  directory = join(root, SET_DIRECTORY),
): Promise<Prepared> {
  const file = join(directory, doc.file);
  const result = await runJob({ task: "process", documentId: doc.id, file, kind: doc.kind });
  if (result.outcome !== "ready" && result.outcome !== "no-text")
    throw new Error(`Extraction failed for ${doc.id}: ${JSON.stringify(result)}`);
  const source: OrganizeSource = {
    name: nameFromPath(file),
    kind: doc.kind,
    pageCount: result.pageCount,
    passages: result.outcome === "ready" ? result.passages.map((passage) => passage.text) : [],
    units: result.outcome === "ready" ? result.pages : [],
  };
  return {
    doc,
    file,
    source,
    visual: organizeNeedsPageImages(source),
    noText: result.outcome === "no-text",
  };
}
