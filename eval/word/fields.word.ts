/**
 * `npm run eval:word` (eval/word/README.md): a renumbered clause's cross-reference in LibreOffice
 * (#746). The invented contract of `tests/helpers/wordContracts.ts`, in English and Chinese, is
 * imported as a Note, a sub-clause added above the one its REF names, and exported, as it is and
 * with the User's edits tracked; LibreOffice opens each export and saves its text, in which the
 * referring clause must show the new number. LibreOffice works a REF out itself as it lays the
 * file out, so this checks that the export keeps it a cross-reference LibreOffice can follow to
 * the renumbered clause; Word, which works out again only fields marked dirty, is the manual
 * check. With INCARNAMIND_WORD_PDFS set to a folder, the exports are kept there for it, as
 * `fields-<language>.docx` and `fields-<language>-tracked.docx`, with LibreOffice's PDFs.
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
  contractFile,
  ENGLISH_CONTRACT,
} from "../../tests/helpers/wordContracts";
import { importWordBytes } from "../../tests/helpers/wordMinds";
import { convertFile, findLibreOffice } from "./libreoffice";

const soffice = findLibreOffice();
const required = process.env.INCARNAMIND_WORD_REQUIRE_LIBREOFFICE === "1";
const keep = process.env.INCARNAMIND_WORD_PDFS;

describe("a renumbered clause's cross-reference opens in LibreOffice with the new number", () => {
  it.each([
    ["English", ENGLISH_CONTRACT],
    ["Chinese", CHINESE_CONTRACT],
  ] as const)(
    "%s",
    async (language, contract) => {
      const dataDir = await createTempDataFolder();
      const core = startCore(dataDir);
      const { mindId, client } = await importWordBytes(core, dataDir, contractFile(contract), {
        origin: "own",
      });
      editMind(client, addItemAfter(contract.after, contract.added));
      await client.settled();
      const exports = [
        [`fields-${language}`, await core.exportMind(mindId, { format: "docx" })],
        [
          `fields-${language}-tracked`,
          await core.exportMind(mindId, { format: "docx", trackChanges: true }),
        ],
      ] as const;
      if (keep) {
        mkdirSync(keep, { recursive: true });
        for (const [name, exported] of exports)
          writeFileSync(join(keep, `${name}.docx`), exported.data);
      }
      if (!soffice) {
        expect(required, "LibreOffice is required (INCARNAMIND_WORD_REQUIRE_LIBREOFFICE)").toBe(
          false,
        );
        console.log("skipped: LibreOffice not found");
        return;
      }
      const folder = mkdtempSync(join(tmpdir(), "incarnamind-word-fields-"));
      try {
        for (const [name, exported] of exports) {
          const path = join(folder, `${name}.docx`);
          writeFileSync(path, exported.data);
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
