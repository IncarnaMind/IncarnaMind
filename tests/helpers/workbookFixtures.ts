import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * A model of ./financeWorkbooks as LibreOffice saved it once it had worked every formula out
 * (tests/fixtures/workbooks; eval/excel/whatIf.excel.ts makes them again and checks they still
 * match): the saved values tests compare with come from LibreOffice, not from the builder. Kept
 * apart from the builder, which the smoke specs load as CommonJS, where `import.meta` can't be read.
 */
export function libreOfficeFixture(name: "dcf" | "lbo" | "three-statements"): Uint8Array {
  return new Uint8Array(
    readFileSync(join(import.meta.dirname, "../fixtures/workbooks", `${name}.xlsx`)),
  );
}
