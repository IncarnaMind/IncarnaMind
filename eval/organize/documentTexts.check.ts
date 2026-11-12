/**
 * Writes the tuning Documents' names and opening text, as Organize reads them, for reading a plan
 * (#2737): `INCARNAMIND_ORGANIZE_MODE=documents INCARNAMIND_ORGANIZE_OUT=<dir> npm run eval:organize`.
 * Extraction runs here, under Vite, because Node alone can't load the processing code.
 */
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import { documentTexts } from "./lib/documentTexts";

const root = fileURLToPath(new URL("../..", import.meta.url));

test("the tuning Documents as Organize reads them", async () => {
  const out = process.env.INCARNAMIND_ORGANIZE_OUT?.trim();
  if (!out) throw new Error("INCARNAMIND_ORGANIZE_OUT names the folder documents.json goes to.");
  const split = process.env.INCARNAMIND_ORGANIZE_SPLIT?.trim() || "tune";
  if (split !== "tune" && split !== "heldout") throw new Error(`No split "${split}".`);
  const texts = await documentTexts(root, split);
  await writeFile(join(out, "documents.json"), `${JSON.stringify(texts, null, 2)}\n`);
  console.log(`${texts.length} Documents' names and opening text in ${out}.`);
});
