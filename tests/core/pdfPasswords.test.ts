/**
 * A password-protected PDF (#763): it fails as "password-protected" until the
 * User unlocks it with its password, which is kept only in the keychain, by
 * Document, and opens it for reading, the image pass and the viewer; a wrong
 * one keeps nothing. The viewer is given it only while it shows that PDF.
 * Forgetting it, or deleting the Document, lets it go, and the password never
 * shows in a logged error.
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import type { Core, Document, Keychain } from "../../src/core";
import { createMemoryKeychain, createTempDataFolder, startCore } from "../helpers/core";
import {
  addAndProcess,
  createSourceFolder,
  linkAndProcess,
  waitForProcessing,
  writeSourceFile,
} from "../helpers/documents";
import { writeLockedPdf } from "../helpers/lockedPdf";
import { buildPdf } from "../helpers/pdf";

const PASSWORD = "tide-tables-7Q!";
const LINES = ["Harbour accounts 2025", "The harbour office opens on Mondays at 8am."];

/** A core with a locked PDF and a Markdown file added, the PDF failed as locked. */
async function withLockedPdf(overrides: Parameters<typeof startCore>[1] = {}) {
  const core = startCore(await createTempDataFolder(), overrides);
  const sources = await createSourceFolder();
  const [locked, notes] = await addAndProcess(core, [
    await writeLockedPdf(sources, "Harbour accounts.pdf", LINES, PASSWORD),
    await writeSourceFile(sources, "Notes.md", "# Notes\n\nNothing locked here.\n"),
  ]);
  return { core, locked: locked as Document, notes: notes as Document };
}

const text = async (core: Core, id: string) =>
  (await core.readDocumentText(id)).pages.map((page) => page.text).join("\n");

/** Reads a Document's file as the viewer does, over the document protocol. */
const view = async (core: Core, id: string) => {
  await new Response((await core.openDocumentFile(id)).stream).arrayBuffer();
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("A password-protected PDF", () => {
  test("fails as locked; a wrong password keeps nothing; the right one is kept and the PDF is read with it", async () => {
    const { core, locked } = await withLockedPdf();
    expect(locked).toMatchObject({
      status: "failed",
      failure: { reason: "password-protected" },
    });
    const changes: string[][] = [];
    core.on("documentPasswords.changed", (ids) => changes.push(ids));

    expect(await core.unlockDocument({ documentId: locked.id, password: "not-it" })).toEqual({
      kind: "wrong-password",
    });
    expect(await core.listDocumentPasswords()).toEqual([]);
    expect(await core.documentPasswordFor(locked.id)).toBeNull();

    const unlocked = await core.unlockDocument({ documentId: locked.id, password: PASSWORD });
    expect(unlocked.kind).toBe("unlocked");
    const [read] = await waitForProcessing(core, [locked.id]);
    expect(read).toMatchObject({ status: "ready", failure: null, pageCount: 1 });
    expect(await text(core, locked.id)).toContain("The harbour office opens on Mondays at 8am.");
    expect(await core.listDocumentPasswords()).toEqual([locked.id]);
    expect(changes).toEqual([[locked.id]]);
  });

  test("the viewer is given a locked PDF's password only while it shows that PDF, and nothing for another Document", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { core, locked, notes } = await withLockedPdf();
    await core.unlockDocument({ documentId: locked.id, password: PASSWORD });
    await waitForProcessing(core, [locked.id]);

    expect(await core.documentPasswordFor(locked.id)).toBeNull();
    await view(core, locked.id);
    expect(await core.documentPasswordFor(locked.id)).toBe(PASSWORD);
    await view(core, notes.id);
    expect(await core.documentPasswordFor(notes.id)).toBeNull();

    // pdf.js reads the file whole before it asks: a moment after, it is still shown; later, not.
    vi.advanceTimersByTime(5_000);
    expect(await core.documentPasswordFor(locked.id)).toBe(PASSWORD);
    vi.advanceTimersByTime(10_000);
    expect(await core.documentPasswordFor(locked.id)).toBeNull();
  });

  test("forgetting the password lets it go and keeps the text read; deleting the Document lets it go too", async () => {
    const { core, locked } = await withLockedPdf();
    await core.unlockDocument({ documentId: locked.id, password: PASSWORD });
    await waitForProcessing(core, [locked.id]);

    await core.forgetDocumentPassword(locked.id);
    expect(await core.listDocumentPasswords()).toEqual([]);
    expect(await core.documentPasswordFor(locked.id)).toBeNull();
    expect(await text(core, locked.id)).toContain("Harbour accounts 2025");

    await core.unlockDocument({ documentId: locked.id, password: PASSWORD });
    expect(await core.listDocumentPasswords()).toEqual([locked.id]);
    await core.deleteDocument(locked.id);
    await vi.waitFor(async () => expect(await core.listDocumentPasswords()).toEqual([]));
  });

  test("only a locked PDF is unlocked, and a password is needed", async () => {
    const { core, locked, notes } = await withLockedPdf();
    await expect(core.unlockDocument({ documentId: notes.id, password: PASSWORD })).rejects.toThrow(
      "Only a PDF is opened with a password.",
    );
    const [open] = await addAndProcess(core, [
      await writeSourceFile(
        await createSourceFolder(),
        "Open.pdf",
        buildPdf([{ lines: ["Nothing locked here either."] }]),
      ),
    ]);
    await expect(
      core.unlockDocument({ documentId: open?.id ?? "", password: PASSWORD }),
    ).rejects.toThrow("This PDF isn’t locked: it opens without a password.");
    expect(await core.listDocumentPasswords()).toEqual([]);
    await expect(core.unlockDocument({ documentId: locked.id, password: "" })).rejects.toThrow(
      "Type the PDF’s password to open it.",
    );
  });

  test("a PDF whose Linked folder is paused while its password is read waits, and is read once resumed", async () => {
    const memory = createMemoryKeychain();
    let release = () => {};
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let asked = () => {};
    const reading = new Promise<void>((resolve) => {
      asked = resolve;
    });
    let holding = false;
    const keychain: Keychain = {
      ...memory,
      get: async (name) => {
        if (holding && name.startsWith("pdf-password:")) {
          asked();
          await released;
        }
        return memory.get(name);
      },
    };
    const core = startCore(await createTempDataFolder(), { keychain });
    const library = await createSourceFolder();
    await writeLockedPdf(library, "Harbour accounts.pdf", LINES, PASSWORD);
    const [locked] = (await linkAndProcess(core, library)) as [Document];
    expect(locked.failure?.reason).toBe("password-protected");
    const folder = (await core.listLinkedFolders())[0];
    if (!folder) throw new Error("Nothing was linked.");

    holding = true;
    await core.unlockDocument({ documentId: locked.id, password: PASSWORD });
    await reading;
    await core.setLinkedFolderPaused(folder.id, true);
    const { documents } = await core.addDocuments([
      await writeSourceFile(await createSourceFolder(), "Notes.md", "# Notes\n\nRead next.\n"),
    ]);
    release();
    // The stopped job gives way: what was queued after it is read, and the PDF waits.
    await waitForProcessing(
      core,
      documents.map((each) => each.id),
    );
    expect((await core.listDocuments()).find((each) => each.id === locked.id)?.status).toBe(
      "queued",
    );

    holding = false;
    await core.setLinkedFolderPaused(folder.id, false);
    await waitForProcessing(core, [locked.id]);
    expect(await text(core, locked.id)).toContain("Harbour accounts 2025");
  });

  test("the password never shows in a logged error, however unlocking or reading goes", async () => {
    const logged: unknown[] = [];
    for (const method of ["error", "warn", "log", "info", "debug"] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        logged.push(...args);
      });
    }
    // A keychain that can't keep secrets: unlocking fails, and says why without the password.
    const refusing = await withLockedPdf({ keychain: createMemoryKeychain("plain-text") });
    const refused = await refusing.core
      .unlockDocument({ documentId: refusing.locked.id, password: PASSWORD })
      .catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(Error);
    logged.push(refused);

    const { core, locked } = await withLockedPdf();
    await core.unlockDocument({ documentId: locked.id, password: `${PASSWORD}-wrong` });
    await core.unlockDocument({ documentId: locked.id, password: PASSWORD });
    await waitForProcessing(core, [locked.id]);
    await core
      .unlockDocument({ documentId: "no-such-document", password: PASSWORD })
      .catch((error: unknown) => logged.push(error));

    const written = logged
      .map((each) =>
        each instanceof Error ? `${each.message}\n${each.stack ?? ""}` : JSON.stringify(each),
      )
      .join("\n");
    expect(written).not.toContain(PASSWORD);
  });
});
