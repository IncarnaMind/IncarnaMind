/**
 * The passwords of locked PDFs (#763), the one place the core reads them:
 * kept only through ../secrets, by Document id, never in the database, a
 * log or an error. Which Documents have one is kept on this device, as the
 * passwords are, so the row's menu can offer to forget it without reading it.
 */
import type { Secrets } from "../secrets";
import type { SettingsStore } from "../settings";

/** The device value listing the Documents whose PDF password is kept. */
const KEPT = "pdfPasswordDocuments";

const secretName = (documentId: string) => `pdf-password:${documentId}`;

/**
 * Why pdf.js couldn't open a PDF, when it was its password: "needed" when
 * none was given, "wrong" when the one given doesn't open it. Null for any
 * other failure. (pdf.js's PasswordResponses: 1, NEED_PASSWORD; 2, INCORRECT_PASSWORD.)
 */
export function passwordProblem(error: unknown): "needed" | "wrong" | null {
  if (!(error instanceof Error) || error.name !== "PasswordException") return null;
  return (error as Error & { code?: unknown }).code === 2 ? "wrong" : "needed";
}

export function createPdfPasswords(
  secrets: Pick<Secrets, "tryGet" | "set" | "delete">,
  settings: Pick<SettingsStore, "readDeviceValue" | "writeDeviceValue">,
) {
  const kept = (): string[] => {
    const value = settings.readDeviceValue(KEPT);
    return Array.isArray(value) ? value.filter((each) => typeof each === "string") : [];
  };

  return {
    /** The Documents whose password is kept. */
    kept,

    /** A Document's kept password; undefined when none is. */
    async of(documentId: string): Promise<string | undefined> {
      if (!kept().includes(documentId)) return undefined;
      return (await secrets.tryGet(secretName(documentId))) ?? undefined;
    },

    /** Keeps the password that opens a Document's PDF. Throws when secrets can't be kept here. */
    async keep(documentId: string, password: string): Promise<void> {
      await secrets.set(secretName(documentId), password);
      if (!kept().includes(documentId)) settings.writeDeviceValue(KEPT, [...kept(), documentId]);
    },

    /** Forgets a Document's password, if one is kept. */
    async forget(documentId: string): Promise<void> {
      if (!kept().includes(documentId)) return;
      settings.writeDeviceValue(
        KEPT,
        kept().filter((each) => each !== documentId),
      );
      await secrets.delete(secretName(documentId));
    },
  };
}
