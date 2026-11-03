import { rename } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, onTestFinished, test } from "vitest";
import { statIdentity } from "../../src/core/documents/files";
import { createTempDataFolder, startCore } from "../helpers/core";
import {
  addAndProcess,
  createSourceFolder,
  linkAndProcess,
  writeSourceFile,
} from "../helpers/documents";

const noWatch = () => ({ close() {} });

describe("Unlinking a Linked folder", () => {
  // Value: protects=a scan already identifying a file cannot add it after unlink; fails_when=addFound checks ownership only before its awaited identification; why_new=CI exposed the 43ms redo-unlink race; seam=public link/unlink/reconcile with the file-identity adapter gated after hashing; no_claim=cancelling known processing jobs (removeFromIndex already does that)
  test("does not add a file whose scan finishes after unlink, and keeps an independent Document", async () => {
    const termSheet = Promise.withResolvers<void>();
    const releaseTermSheet = Promise.withResolvers<void>();
    onTestFinished(() => releaseTermSheet.resolve());
    const core = startCore(await createTempDataFolder(), {
      linkedFolders: {
        watch: noWatch,
        stat: async (path) => {
          if (path.endsWith("Term sheet.md")) {
            termSheet.resolve();
            await releaseTermSheet.promise;
          }
          return statIdentity(path);
        },
      },
    });
    const folder = await createSourceFolder();
    const teaserPath = await writeSourceFile(folder, "Teaser.md", "A business for sale.\n");
    await writeSourceFile(folder, "Term sheet.md", "The price is 4 million.\n");
    const [teaser] = await addAndProcess(core, [teaserPath]);
    if (!teaser) throw new Error("The independent Document wasn't added.");
    const linked = await core.addLinkedFolder(folder);
    await termSheet.promise;
    expect((await core.listDocuments()).map((document) => document.id)).toEqual([teaser.id]);

    await core.removeLinkedFolder(linked.id, { keep: [teaser.id] });
    releaseTermSheet.resolve();
    await core.reconcileDocuments();

    expect((await core.listDocuments()).map((document) => document.id)).toEqual([teaser.id]);
  });

  // Value: protects=aborting a move leaves its source for the normal missing-file pass; fails_when=move detection consumes the source before the ownership abort; why_new=review found the two-folder form of the same race; seam=public reconcile and unlink with destination identification gated; no_claim=a completed relocation (covered by linkedFolders move tests)
  test("an aborted move does not leave the source available at its missing path", async () => {
    const sourceFolder = await createSourceFolder();
    const targetFolder = await createSourceFolder();
    const sourcePath = await writeSourceFile(sourceFolder, "old.md", "The same contents.\n");
    const targetPath = join(targetFolder, "new.md");
    const identifying = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let holdTarget = false;
    onTestFinished(() => release.resolve());
    const core = startCore(await createTempDataFolder(), {
      linkedFolders: {
        watch: noWatch,
        stat: async (path) => {
          if (holdTarget && path === targetPath) {
            identifying.resolve();
            await release.promise;
          }
          return statIdentity(path);
        },
      },
    });
    const [source] = await linkAndProcess(core, sourceFolder);
    if (!source) throw new Error("The source Document wasn't linked.");
    const target = await core.addLinkedFolder(targetFolder);
    await core.reconcileDocuments();
    await rename(sourcePath, targetPath);
    holdTarget = true;
    const pass = core.reconcileDocuments();
    await identifying.promise;

    await core.removeLinkedFolder(target.id);
    release.resolve();
    await pass;

    expect(await core.listDocuments()).toEqual([
      expect.objectContaining({ id: source.id, path: sourcePath, fileStatus: "missing" }),
    ]);
  });
});
