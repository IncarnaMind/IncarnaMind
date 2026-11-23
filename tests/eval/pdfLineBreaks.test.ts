/**
 * The stored text of every PDF under eval/ (#3288): each line break a Chinese PDF's pages keep
 * beside a CJK character or a full-width mark, with a few characters each side of it, and a hash
 * of each page of every other PDF. A break the reader adds or takes away, such as a cut inside a
 * sentence, fails here and shows in the diff; a change meant is an update of the recorded file
 * (`vitest -u`), read in review like any other change.
 */
import { createHash } from "node:crypto";
import { readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { processFile } from "../../src/core/documents/processing";
import { isSpaceless } from "../../src/shared/text";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const HAN = /\p{Script=Han}/u;
/** The characters shown each side of a break. */
const AROUND = 4;

async function pdfsUnder(dir: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await pdfsUnder(path)));
    else if (entry.name.toLowerCase().endsWith(".pdf")) found.push(path);
  }
  return found;
}

/** Each newline of `text` beside a CJK character or a full-width mark, with its context. */
function breaksOf(text: string): string[] {
  const chars = [...text];
  return chars.flatMap((char, at) => {
    if (char !== "\n") return [];
    if (!isSpaceless(chars[at - 1] ?? "") && !isSpaceless(chars[at + 1] ?? "")) return [];
    const before = chars.slice(Math.max(0, at - AROUND), at).join("");
    const after = chars.slice(at + 1, at + 1 + AROUND).join("");
    return [JSON.stringify(`${before}⏎${after}`)];
  });
}

const hashOf = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 12);

describe("The stored text of eval/'s PDFs", { timeout: 300_000 }, () => {
  // protects=the reader keeps and joins a Chinese PDF's line breaks as recorded, so a new cut inside a sentence or a heading run into its sentence shows, and every other PDF's text stays as it was (#3288); fails_when=a change to the PDF reader adds or removes a break beside Chinese text, or changes another PDF's page text, without the recorded file being updated
  test("each Chinese PDF keeps the breaks recorded, and every other PDF's pages read as recorded", async () => {
    const files = (await pdfsUnder(join(ROOT, "eval")))
      .map((file) => ({ file, name: relative(ROOT, file).split(sep).join("/") }))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const chinese: string[] = [];
    const others: string[] = [];
    for (const { file, name } of files) {
      const read = await processFile({ task: "process", documentId: name, kind: "pdf", file });
      const pages = read.outcome === "ready" ? read.pages : [];
      if (pages.some((page) => HAN.test(page.text))) {
        chinese.push(
          `## ${name}`,
          ...pages.flatMap((page) => breaksOf(page.text).map((each) => `p${page.page} ${each}`)),
        );
      } else {
        others.push(
          `## ${name}`,
          ...(pages.length === 0
            ? [read.outcome]
            : pages.map((page) => `p${page.page} ${hashOf(page.text)}`)),
        );
      }
    }
    const recorded = [
      `# Line breaks the stored text keeps beside CJK text, ${AROUND} characters each side`,
      ...chinese,
      "# Every other PDF: each page's stored text, as the start of its SHA-256",
      ...others,
      "",
    ].join("\n");
    await expect(recorded).toMatchFileSnapshot("../fixtures/eval-pdf-line-breaks.txt");
  });
});
