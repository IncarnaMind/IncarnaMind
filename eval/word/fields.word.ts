/**
 * `npm run eval:word` (eval/word/README.md): a renumbered clause's cross-reference in LibreOffice
 * (#746). The invented contract of `tests/helpers/wordContracts.ts`, in English and Chinese, is
 * imported as a Note, a sub-clause added above the one its REF names, and exported, as it is and
 * with the User's edits tracked; LibreOffice opens each export and saves its text, in which the
 * referring clause must show the new number. In the tracked export the new number is the User's
 * tracked change, so the text is its redline: the old number deleted, then the new one. LibreOffice
 * can't keep a tracked change inside a field's result when it accepts or rejects changes
 * (rejecting leaves the new number, accepting has it work the REF out itself), so the accepted
 * and rejected views are checked in `tests/core/wordFields.test.ts`, on the file as Word reads it.
 * LibreOffice shows a field's result as the file saved it, and doesn't read the mark that asks
 * Word to work a field out again, so this checks the number the export writes: what any viewer
 * that doesn't refresh fields shows. `fields-Chinese-past-nine` is the Chinese contract as Word
 * saves it once 第二条 runs past nine, its `\r` REF showing "第二条（九）" and its `\n` REF
 * "（九）", which become "第二条（十）" and "（十）". With INCARNAMIND_WORD_PDFS set to a folder, the
 * exports are kept there for a person to open in Word, as `fields-<language>.docx`,
 * `fields-<language>-tracked.docx` and `fields-Chinese-past-nine.docx`, with LibreOffice's PDFs.
 * Without LibreOffice its part is skipped, unless INCARNAMIND_WORD_REQUIRE_LIBREOFFICE=1.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createTempDataFolder, startCore } from "../../tests/helpers/core";
import { editMind } from "../../tests/helpers/minds";
import {
  addItemAfter,
  CHINESE_CONTRACT,
  CHINESE_PAST_NINE,
  type Contract,
  contractFile,
  ENGLISH_CONTRACT,
} from "../../tests/helpers/wordContracts";
import { importWordBytes } from "../../tests/helpers/wordMinds";
import { convertFile, findLibreOffice } from "./libreoffice";

const soffice = findLibreOffice();
const required = process.env.INCARNAMIND_WORD_REQUIRE_LIBREOFFICE === "1";
const keep = process.env.INCARNAMIND_WORD_PDFS;

/** The contract with a sub-clause added above the referred one, exported as it is and with the edits tracked. */
async function renumbered(contract: Contract) {
  const dataDir = await createTempDataFolder();
  const core = startCore(dataDir);
  const { mindId, client } = await importWordBytes(core, dataDir, contractFile(contract), {
    origin: "own",
  });
  editMind(client, addItemAfter(contract.after, contract.added));
  await client.settled();
  return {
    plain: (await core.exportMind(mindId, { format: "docx" })).data,
    tracked: (await core.exportMind(mindId, { format: "docx", trackChanges: true })).data,
  };
}

const kept = (name: string, data: Uint8Array) => {
  if (!keep) return;
  mkdirSync(keep, { recursive: true });
  writeFileSync(join(keep, `${name}.docx`), data);
};

describe("a renumbered clause's cross-reference opens in LibreOffice with the new number", () => {
  it.each([
    ["English", ENGLISH_CONTRACT],
    ["Chinese", CHINESE_CONTRACT],
  ] as const)(
    "%s",
    async (language, contract) => {
      const { plain, tracked } = await renumbered(contract);
      // Each export, and the referring clause's words as it must show them.
      const exports: [string, Uint8Array, string][] = [
        [`fields-${language}`, plain, contract.renumbered],
        [`fields-${language}-tracked`, tracked, contract.redline],
      ];
      if (language === "Chinese") {
        const pastNine = (await renumbered(CHINESE_PAST_NINE)).plain;
        exports.push(["fields-Chinese-past-nine", pastNine, CHINESE_PAST_NINE.renumbered]);
      }
      for (const [name, data] of exports) kept(name, data);
      if (!soffice) {
        expect(required, "LibreOffice is required (INCARNAMIND_WORD_REQUIRE_LIBREOFFICE)").toBe(
          false,
        );
        console.log("skipped: LibreOffice not found");
        return;
      }
      const folder = mkdtempSync(join(tmpdir(), "incarnamind-word-fields-"));
      try {
        for (const [name, data, words] of exports) {
          const path = join(folder, `${name}.docx`);
          writeFileSync(path, data);
          if (keep) await convertFile(soffice, path, "pdf", ".pdf", join(keep, `${name}.pdf`));
          const text = await convertFile(soffice, path, "txt:Text (encoded):UTF8", ".txt");
          expect(text.opened, text.problem).toBe(true);
          expect(text.data?.toString("utf8"), name).toContain(words);
        }
      } finally {
        rmSync(folder, { recursive: true, force: true });
      }
    },
    5 * 60_000,
  );
});
