import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { readManifest, WORD_DIR } from "../../eval/word/corpus";
import {
  checkEdits,
  checkExport,
  checkListExport,
  checkReview,
  checkTheirChanges,
} from "../../eval/word/exports";
import { checkImport } from "../../eval/word/imports";

const files = readManifest().map((entry) => entry.file);

test.each(files)(
  "%s imports as a Mind the editor takes, its text all kept and what it kept counted",
  async (file) => {
    const outcome = await checkImport(readFileSync(join(WORD_DIR, file)));
    expect(outcome.ok, outcome.detail).toBe(true);
  },
  60_000,
);

test.each(files)(
  "%s exports back into itself: unchanged byte for byte, edited with the rest as it was",
  async (file) => {
    const outcome = await checkExport(readFileSync(join(WORD_DIR, file)));
    expect(outcome.ok, outcome.detail).toBe(true);
  },
  60_000,
);

test.each(files)(
  "%s takes edits of every kind: the export is a package Word opens and imports again",
  async (file) => {
    const outcome = await checkEdits(readFileSync(join(WORD_DIR, file)));
    expect(outcome.ok, outcome.detail).toBe(true);
  },
  60_000,
);

test.each(files)(
  "%s exports for review: the User's edits and changes still waiting tracked, comments whole, and accepting every change gives the Mind's text",
  async (file) => {
    const outcome = await checkReview(readFileSync(join(WORD_DIR, file)));
    expect(outcome.ok, outcome.detail).toBe(true);
  },
  60_000,
);

test.each(files)(
  "%s has someone's changes accepted and rejected: the rest go back with their author and date, and nothing is tracked as the User's",
  async (file) => {
    const outcome = await checkTheirChanges(readFileSync(join(WORD_DIR, file)));
    expect(outcome.ok, outcome.detail).toBe(true);
  },
  60_000,
);

test.each(files)(
  "%s exports with the Citations in a list at the end: [1] in the text, no footnote, a package Word opens",
  async (file) => {
    const outcome = await checkListExport(readFileSync(join(WORD_DIR, file)));
    expect(outcome.ok, outcome.detail).toBe(true);
  },
  60_000,
);
