/**
 * Deleting many Documents at once (#1349): one step for the core, however
 * many there are, and one step back.
 */
import { describe, expect, test } from "vitest";
import { createTempDataFolder, startCore } from "../helpers/core";
import { createSourceFolder, linkAndProcess, writeSourceFile } from "../helpers/documents";

const COUNT = 120;

async function libraryOf(count: number) {
  const core = startCore(await createTempDataFolder());
  const folder = await createSourceFolder();
  for (let at = 0; at < count; at++) {
    await writeSourceFile(folder, `Note ${at}.md`, `# Note ${at}\n\nHarbour tides, note ${at}.\n`);
  }
  const documents = await linkAndProcess(core, folder);
  return { core, ids: documents.map((document) => document.id) };
}

describe("Deleting many Documents", { timeout: 120_000 }, () => {
  // protects=a bulk delete is one step: every Document goes to Recently deleted at once, with one removal event and one Library change, and one restore brings them all back; fails_when=the core removes them one by one, announcing each; no_claim=how long it takes on a given computer.
  test("moves them all to Recently deleted in one step, and one restore brings them back", async () => {
    const { core, ids } = await libraryOf(COUNT);
    const removed: string[][] = [];
    let changed = 0;
    core.on("documents.removed", (each) => removed.push(each));
    core.on("library.changed", () => changed++);

    await core.deleteDocuments(ids);

    expect(removed).toEqual([ids]);
    expect(changed).toBeLessThanOrEqual(1);
    expect(await core.listDocuments()).toEqual([]);
    expect((await core.listDeleted()).filter((item) => item.kind === "document")).toHaveLength(
      COUNT,
    );

    await core.restore(ids.map((id) => ({ kind: "document" as const, id })));
    expect((await core.listDocuments()).map((document) => document.id).sort()).toEqual(
      [...ids].sort(),
    );
  });

  // protects=a bulk delete naming a Document that isn't there deletes none of them; fails_when=some go and the rest stay; no_claim=none beyond protects.
  test("deletes none when one of them isn't there", async () => {
    const { core, ids } = await libraryOf(3);

    await expect(core.deleteDocuments([...ids, "no-such-document"])).rejects.toThrow();

    expect(await core.listDocuments()).toHaveLength(3);
  });
});
