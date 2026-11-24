/**
 * Whether a deck's author protected it from changes, so a hand edit never writes it (#149): a
 * digital signature (an edit breaks it), "Mark as Final", or a password to modify. PowerPoint
 * opens such a deck read-only or warns; IncarnaMind leaves it as it is.
 */
import type { ZipArchive } from "../documents/formats/zip";

export type DeckProtection = "signed" | "final" | "protected";

export async function protectionOf(zip: ZipArchive): Promise<DeckProtection | null> {
  if (zip.names().some((name) => name.startsWith("_xmlsignatures/"))) return "signed";
  const custom = (await zip.readText("docProps/custom.xml")) ?? "";
  if (/name="_MarkAsFinal"[^>]*>\s*<vt:bool>\s*(true|1)\s*<\/vt:bool>/i.test(custom))
    return "final";
  const presentation = (await zip.readText("ppt/presentation.xml")) ?? "";
  if (/<p:modifyVerifier\b/.test(presentation)) return "protected";
  return null;
}
