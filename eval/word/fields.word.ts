/**
 * `npm run eval:word` (eval/word/README.md): a renumbered clause's cross-reference in LibreOffice
 * (#746). The invented contract of `tests/helpers/wordContracts.ts`, in English and Chinese, is
 * imported as a Note, a sub-clause added above the one its REF names, and exported, as it is and
 * with the User's edits tracked; LibreOffice opens each export and saves its text, in which the
 * referring clause must show the new number. LibreOffice shows a field's result as the file saved
 * it, and doesn't read the mark that asks Word to work a field out again, so this checks the
 * number the export writes: what any viewer that doesn't refresh fields shows. Whether Word works
 * out again each field marked dirty is the manual check: with INCARNAMIND_WORD_PDFS set to a
 * folder, the exports are kept there for it, as `fields-<language>.docx` and
 * `fields-<language>-tracked.docx`, with `fields-Chinese-past-nine.docx`, whose REF keeps the
 * file's （九） for Word to make （十）, and LibreOffice's PDFs. Without LibreOffice its part is
 * skipped, unless INCARNAMIND_WORD_REQUIRE_LIBREOFFICE=1.
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
      const exports = [
        [`fields-${language}`, plain],
        [`fields-${language}-tracked`, tracked],
      ] as const;
      for (const [name, data] of exports) kept(name, data);
      if (language === "Chinese")
        kept("fields-Chinese-past-nine", (await renumbered(CHINESE_PAST_NINE)).plain);
      if (!soffice) {
        expect(required, "LibreOffice is required (INCARNAMIND_WORD_REQUIRE_LIBREOFFICE)").toBe(
          false,
        );
        console.log("skipped: LibreOffice not found");
        return;
      }
      const folder = mkdtempSync(join(tmpdir(), "incarnamind-word-fields-"));
      try {
        for (const [name, data] of exports) {
          const path = join(folder, `${name}.docx`);
          writeFileSync(path, data);
          if (keep) await convertFile(soffice, path, "pdf", ".pdf", join(keep, `${name}.pdf`));
          const text = await convertFile(soffice, path, "txt:Text (encoded):UTF8", ".txt");
          expect(text.opened, text.problem).toBe(true);
          expect(text.data?.toString("utf8"), name).toContain(contract.renumbered);
        }
      } finally {
        rmSync(folder, { recursive: true, force: true });
      }
    },
    5 * 60_000,
  );
});
