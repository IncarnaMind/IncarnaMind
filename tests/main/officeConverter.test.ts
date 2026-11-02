/**
 * The LibreOffice adapter (#762): found where it is, run headless with a
 * profile of its own. A script on the PATH stands in for LibreOffice here,
 * so nothing on the machine running the tests starts a real one.
 */
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { createOfficeConverter } from "../../src/main/officeConverter";
import { createProcessLauncher } from "../../src/main/processes";
import { createTempDataFolder } from "../helpers/core";

const CONVERTS = `#!/bin/sh
if [ "$1" = "--version" ]; then
  echo "LibreOffice 25.2.1.2 420(Build:2)"
  exit 0
fi
out=""
target=""
previous=""
for argument in "$@"; do
  if [ "$previous" = "--outdir" ]; then out="$argument"; fi
  if [ "$previous" = "--convert-to" ]; then target="$argument"; fi
  previous="$argument"
  input="$argument"
done
name="\${input##*/}"
name="\${name%.*}"
# It writes beside the file it was given, as a converter may: the User's file must not be that file.
printf 'the converter wrote here' > "$input"
printf 'converted bytes' > "$out/$name.$target"
`;

const FAILS = `#!/bin/sh
if [ "$1" = "--version" ]; then
  echo "LibreOffice 25.2.1.2 420(Build:2)"
  exit 0
fi
echo "no filter for this file" >&2
exit 3
`;

/** A folder with one executable named `soffice`, and the launcher that finds it on its PATH. */
async function withLibreOffice(script: string) {
  const home = await createTempDataFolder();
  const bin = join(home, "bin");
  await mkdir(bin);
  await writeFile(join(bin, "soffice"), script, { mode: 0o755 });
  const processes = createProcessLauncher(async () => ({ PATH: bin }));
  const converter = createOfficeConverter({
    processes,
    home,
    platform: "linux",
    env: {},
    tempDir: home,
    look: ["soffice"],
    versionTimeoutMs: 10_000,
    convertTimeoutMs: 30_000,
  });
  return { home, converter };
}

describe("The LibreOffice adapter", () => {
  test.skipIf(process.platform === "win32")(
    "finds it on the PATH, converts a copy, and leaves the original as it was",
    async () => {
      const { home, converter } = await withLibreOffice(CONVERTS);
      const original = join(home, "Contract.doc");
      await writeFile(original, "the original .doc");
      const before = await readFile(original);

      expect(await converter.available()).toBe(true);
      const result = await converter.convert(original, "docx");

      expect(result.outcome).toBe("converted");
      if (result.outcome !== "converted") throw new Error("not converted");
      expect(result.name).toBe("Contract.docx");
      expect(new TextDecoder().decode(result.bytes)).toBe("converted bytes");
      // Nothing wrote the User's file, and nothing was written beside it: the copy went to
      // the private folder the adapter made, now gone.
      expect(await readFile(original)).toEqual(before);
      expect((await readdir(home)).sort()).toEqual(["Contract.doc", "bin"]);
    },
  );

  test.skipIf(process.platform === "win32")(
    "says when LibreOffice isn't there, and a failed conversion is a problem, not a crash",
    async () => {
      const missing = createOfficeConverter({
        processes: createProcessLauncher(async () => ({ PATH: "/nonexistent" })),
        home: "/nonexistent",
        platform: "linux",
        env: {},
        look: ["soffice"],
      });
      expect(await missing.available()).toBe(false);
      const { home, converter } = await withLibreOffice(FAILS);
      const original = join(home, "Contract.doc");
      await writeFile(original, "the original .doc");
      const result = await converter.convert(original, "docx");
      expect(result).toEqual({ outcome: "failed", message: "no filter for this file" });
      expect(await readFile(original, "utf8")).toBe("the original .doc");
    },
  );
});
