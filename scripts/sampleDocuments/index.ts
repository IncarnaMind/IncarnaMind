/**
 * Writes the sample PDFs in `data/` from the pages in ./samples:
 * `npm run samples:generate`. data/README.md says what the files are and on
 * what basis this repository may redistribute them.
 */
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { bytesOf, SAMPLE_DOCUMENTS } from "./samples";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

for (const document of SAMPLE_DOCUMENTS) {
  writeFileSync(join(ROOT, "data", document.file), bytesOf(document));
  process.stdout.write(`${document.file}: ${document.pageCount} pages\n`);
}
