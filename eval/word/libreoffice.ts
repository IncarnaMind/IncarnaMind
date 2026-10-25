import { execFile, execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const TIMEOUT_MS = 3 * 60_000;

/** The LibreOffice binary: INCARNAMIND_SOFFICE, else `soffice` or `libreoffice` on the PATH. */
export function findLibreOffice(): string | undefined {
  const named = process.env.INCARNAMIND_SOFFICE;
  if (named) return named;
  for (const command of ["soffice", "libreoffice"]) {
    try {
      execFileSync(command, ["--version"], { stdio: "ignore", timeout: 60_000 });
      return command;
    } catch {
      // not this one
    }
  }
  return undefined;
}

export interface Conversion {
  opened: boolean;
  /** Size of the PDF LibreOffice wrote, when it did. */
  pdfBytes: number;
  /** What went wrong, when `opened` is false. */
  problem?: string;
}

/**
 * Opens a file in LibreOffice headless by converting it to PDF, with a profile of its own in a
 * temporary folder so the User's LibreOffice settings and documents are never touched. With
 * `keep`, the PDF is also copied there, as `keep`'s path says, for a person to look at.
 */
export async function convertToPdf(
  soffice: string,
  file: string,
  keep?: string,
): Promise<Conversion> {
  const converted = await convertFile(soffice, file, "pdf", ".pdf", keep);
  return {
    opened: converted.opened,
    pdfBytes: converted.data?.length ?? 0,
    ...(converted.problem !== undefined && { problem: converted.problem }),
  };
}

/**
 * Converts a file with LibreOffice headless to `target` (a format, or a filter with its options,
 * as `--convert-to` takes it), in a profile of its own, and gives back what it wrote, whose name
 * ends with `extension`. With `keep`, that file is also copied there.
 */
export function convertFile(
  soffice: string,
  file: string,
  target: string,
  extension: string,
  keep?: string,
): Promise<{ opened: boolean; data?: Buffer; problem?: string }> {
  const work = mkdtempSync(join(tmpdir(), "incarnamind-word-"));
  const args = [
    `-env:UserInstallation=file://${join(work, "profile")}`,
    "--headless",
    "--norestore",
    "--convert-to",
    target,
    "--outdir",
    join(work, "out"),
    file,
  ];
  return new Promise((resolve) => {
    execFile(soffice, args, { timeout: TIMEOUT_MS }, (error, _stdout, stderr) => {
      let result: { opened: boolean; data?: Buffer; problem?: string };
      try {
        const written = readdirSync(join(work, "out")).find((name) => name.endsWith(extension));
        const data = written ? readFileSync(join(work, "out", written)) : undefined;
        if (written && data && data.length > 0 && keep) {
          mkdirSync(dirname(keep), { recursive: true });
          copyFileSync(join(work, "out", written), keep);
        }
        result =
          data && data.length > 0
            ? { opened: true, data }
            : { opened: false, problem: error?.message ?? (stderr.trim() || "nothing written") };
      } catch {
        result = { opened: false, problem: error?.message ?? "nothing written" };
      }
      rmSync(work, { recursive: true, force: true });
      resolve(result);
    });
  });
}

/**
 * A Basic module that opens a file, accepts every tracked change, and saves
 * its text; what went wrong, if anything, goes into the target's ".error".
 */
const ACCEPT_MODULE = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE script:module PUBLIC "-//OpenOffice.org//DTD OfficeDocument 1.0//EN" "module.dtd">
<script:module xmlns:script="http://openoffice.org/2000/script" script:name="Module1" script:language="StarBasic">
Sub AcceptAll(source As String, target As String)
  On Error GoTo Failed
  Dim opening() As New com.sun.star.beans.PropertyValue
  Dim document As Object
  document = StarDesktop.loadComponentFromURL(ConvertToURL(source), "_blank", 0, opening())
  Dim dispatcher As Object
  dispatcher = createUnoService("com.sun.star.frame.DispatchHelper")
  dispatcher.executeDispatch(document.getCurrentController().getFrame(), ".uno:AcceptAllTrackedChanges", "", 0, Array())
  Dim saving(1) As New com.sun.star.beans.PropertyValue
  saving(0).Name = "FilterName"
  saving(0).Value = "Text (encoded)"
  saving(1).Name = "FilterOptions"
  saving(1).Value = "UTF8,LF"
  document.storeToURL(ConvertToURL(target), saving())
  document.close(True)
  StarDesktop.terminate()
  Exit Sub
Failed:
  Dim file As Integer
  file = FreeFile
  Open target &amp; ".error" For Output As #file
  Print #file, "Basic error " &amp; Err &amp; " on line " &amp; Erl &amp; ": " &amp; Error$
  Close #file
  StarDesktop.terminate()
End Sub
</script:module>
`;

const LIBRARY = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE library:library PUBLIC "-//OpenOffice.org//DTD OfficeDocument 1.0//EN" "library.dtd">
<library:library xmlns:library="http://openoffice.org/2000/library" library:name="Standard" library:readonly="false" library:passwordprotected="false">
 <library:element library:name="Module1"/>
</library:library>
`;

const libraries = (kind: "script" | "dialog") =>
  `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE library:libraries PUBLIC "-//OpenOffice.org//DTD OfficeDocument 1.0//EN" "libraries.dtd">
<library:libraries xmlns:library="http://openoffice.org/2000/library" xmlns:xlink="http://www.w3.org/1999/xlink">
 <library:library library:name="Standard" xlink:href="$(USER)/basic/Standard/${kind}.xlb/" xlink:type="simple" library:link="false"/>
</library:libraries>
`;

const run = (soffice: string, args: string[]) =>
  new Promise<{ error: Error | null; output: string }>((resolve) => {
    execFile(soffice, args, { timeout: TIMEOUT_MS }, (error, stdout, stderr) =>
      resolve({ error, output: `${stdout}${stderr}`.trim() }),
    );
  });

/**
 * Opens a .docx in LibreOffice headless, accepts every tracked change in it
 * (#107), and returns its text, a paragraph a line: a Basic macro does it, in
 * a profile of its own in a temporary folder, which LibreOffice makes first.
 */
export async function acceptAllChanges(
  soffice: string,
  file: string,
): Promise<{ text: string } | { problem: string }> {
  const work = mkdtempSync(join(tmpdir(), "incarnamind-word-accept-"));
  const profile = [
    `-env:UserInstallation=file://${join(work, "profile")}`,
    "--headless",
    "--norestore",
  ];
  try {
    await run(soffice, [...profile, "--terminate_after_init"]);
    const basic = join(work, "profile", "user", "basic");
    const standard = join(basic, "Standard");
    if (!existsSync(join(standard, "script.xlb"))) {
      mkdirSync(standard, { recursive: true });
      writeFileSync(join(basic, "script.xlc"), libraries("script"));
      writeFileSync(join(basic, "dialog.xlc"), libraries("dialog"));
      writeFileSync(join(standard, "script.xlb"), LIBRARY);
      writeFileSync(join(standard, "dialog.xlb"), LIBRARY.replace(/\n <library:element[^>]*>/, ""));
    }
    writeFileSync(join(standard, "Module1.xba"), ACCEPT_MODULE);
    const target = join(work, "accepted.txt");
    const { error, output } = await run(soffice, [
      ...profile,
      `macro:///Standard.Module1.AcceptAll("${file}","${target}")`,
    ]);
    if (existsSync(target)) return { text: readFileSync(target, "utf8") };
    const said = existsSync(`${target}.error`)
      ? readFileSync(`${target}.error`, "utf8").trim()
      : "";
    const basicFiles = existsSync(standard) ? readdirSync(standard).join(", ") : "none";
    return {
      problem: [said, output, error?.message, `Standard holds: ${basicFiles}`]
        .filter(Boolean)
        .join(" | "),
    };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
