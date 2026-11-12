import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Core, ImportWordFileInput } from "../../src/core";
import { wordFileOf, wordImportProgressOf } from "../../src/shared/wordFiles";
import { connectToMind, type MindClient } from "./mindClient";

/** Imports a Word file as a Mind and waits until every Block is in it; returns a client of the Mind. */
export async function importWordMind(
  core: Core,
  input: ImportWordFileInput,
): Promise<{ mindId: string; client: MindClient }> {
  const result = await core.importWordFile(input);
  if (!result.ok) throw new Error(`Refused: ${result.refusal}`);
  const client = await connectToMind(core, result.mind.id);
  await new Promise<void>((resolve) => {
    const check = () => {
      if (wordFileOf(client.doc) && wordImportProgressOf(client.doc) === null) {
        client.doc.off("update", check);
        resolve();
      }
    };
    client.doc.on("update", check);
    check();
  });
  return { mindId: result.mind.id, client };
}

/** Saves a Word file's bytes as `name` in `folder`, then imports it as `importWordMind` does. */
export async function importWordBytes(
  core: Core,
  folder: string,
  bytes: Buffer,
  { name = "Lease.docx", ...input }: Omit<ImportWordFileInput, "path"> & { name?: string },
): Promise<{ mindId: string; client: MindClient }> {
  const path = join(folder, name);
  await writeFile(path, bytes);
  return importWordMind(core, { ...input, path });
}
