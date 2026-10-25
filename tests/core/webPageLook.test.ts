/**
 * A saved web page kept as it looks (#756): a PDF of each version, made in
 * the background only when the User asks, at the save or by the setting,
 * kept by its content beside the snapshots, served with the page, made again
 * after it failed or the app quit, and gone with the page. The window that
 * makes it stands in here.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import { type Core, DATABASE_FILE } from "../../src/core";
import type { PageLook } from "../../src/core/adapters";
import type { Document, SaveWebPageInput, WebPageLookFailure } from "../../src/core/api";
import { openDatabase } from "../../src/core/storage";
import { createTempDataFolder, nextTurn, queryDatabase, startCore } from "../helpers/core";
import { waitForDocuments, waitForProcessing } from "../helpers/documents";
import { startWeb } from "../helpers/web";

const REPORT = readFileSync(new URL("../fixtures/web/report.html", import.meta.url));

/** Makes "%PDF-" files that say which page and which time, or fails as told. */
function standInLook(fail: () => WebPageLookFailure | null = () => null) {
  const asked: string[] = [];
  const look: PageLook = {
    async render(address) {
      asked.push(address);
      const failure = fail();
      if (failure) return { failure, message: "As the stand-in was told." };
      return { pdf: new TextEncoder().encode(`%PDF-1.7 ${address} ${asked.length}`) };
    },
  };
  return { look, asked };
}

/** Work on files that was started takes several round trips to the disk: this takes more. */
async function lateFileWork(dir: string) {
  for (let hop = 0; hop < 12; hop++) await stat(dir);
}

async function startSite() {
  let body = REPORT.toString("utf8");
  const web = await startWeb({ "/report": () => ({ status: 200, body }) });
  return {
    ...web,
    address: `http://127.0.0.1:${web.port}/report`,
    change: () => {
      body = body.replace("Harbour trade in 2026", "Harbour trade in 2026, revised");
    },
  };
}

async function saved(core: Core, input: SaveWebPageInput) {
  const result = await core.saveWebPage(input);
  if (result.outcome !== "saved") throw new Error(JSON.stringify(result));
  await waitForProcessing(core, [result.document.id]);
  return result.document.id;
}

const lookOf = async (core: Core, id: string) =>
  (await core.listDocuments()).find((document) => document.id === id)?.web?.look ?? null;

const settled = (core: Core, id: string) =>
  waitForDocuments(core, (documents) => {
    const look = documents.find((document) => document.id === id)?.web?.look;
    expect(look?.status === "saved" || look?.status === "failed").toBe(true);
  });

describe("A web page kept as it looks", { timeout: 30_000 }, () => {
  test("off by default: a page saved or fetched again is never loaded for its look", async () => {
    const site = await startSite();
    const stand = standInLook();
    const core = startCore(await createTempDataFolder(), {
      ...site.adapters,
      pageLook: stand.look,
    });
    expect((await core.getSettings()).user.keepWebPageLook).toBe(false);

    const id = await saved(core, { address: site.address });
    site.change();
    await core.fetchWebPageAgain(id);
    await waitForProcessing(core, [id]);

    expect(await lookOf(core, id)).toBeNull();
    expect(stand.asked).toEqual([]);
  });

  test("asked at the save, the PDF is made in the background, kept by its content and served with the page", async () => {
    const site = await startSite();
    const stand = standInLook();
    const dataDir = await createTempDataFolder();
    const core = startCore(dataDir, { ...site.adapters, pageLook: stand.look });
    const statuses: (string | undefined)[] = [];
    core.on("document.status", (document: Document) => statuses.push(document.web?.look?.status));

    const id = await saved(core, { address: site.address, keepLook: true });
    const [page] = await settled(core, id);
    const look = (await core.listDocuments()).find((document) => document.id === id)?.web?.look;
    expect(statuses).toContain("saving");
    expect(look).toEqual({
      status: "saved",
      savedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T.*Z$/),
      path: expect.stringMatching(/^looks\/[0-9a-f]{64}\.pdf$/),
    });
    expect(stand.asked).toEqual([site.address]);
    if (look?.status !== "saved" || !page) throw new Error("Not saved.");

    const file = join(dataDir, "Web pages", look.path);
    expect(readFileSync(file, "utf8")).toBe(`%PDF-1.7 ${site.address} 1`);
    const served = await core.openDocumentImage(id, look.path);
    expect(served).toMatchObject({ type: "application/pdf", size: readFileSync(file).byteLength });
    await served.stream.cancel();
    await expect(core.openDocumentImage(id, `looks/${"0".repeat(64)}.pdf`)).rejects.toThrow();
  });

  test("with the setting on, a save keeps it unless it says not to; fetched again, a new version gets its own and an unchanged one keeps its", async () => {
    const site = await startSite();
    const stand = standInLook();
    const core = startCore(await createTempDataFolder(), {
      ...site.adapters,
      pageLook: stand.look,
    });
    await core.updateSettings({ user: { keepWebPageLook: true } });

    const id = await saved(core, { address: site.address });
    await settled(core, id);
    const first = await lookOf(core, id);

    await core.fetchWebPageAgain(id);
    await waitForProcessing(core, [id]);
    expect(await lookOf(core, id)).toEqual(first);
    expect(stand.asked).toHaveLength(1);

    site.change();
    await core.fetchWebPageAgain(id);
    await waitForProcessing(core, [id]);
    await settled(core, id);
    const second = await lookOf(core, id);
    expect(second?.status).toBe("saved");
    expect(second).not.toEqual(first);
    expect(stand.asked).toHaveLength(2);

    const other = await startWeb({ "/other": () => ({ status: 200, body: REPORT }) });
    const otherId = await saved(core, {
      address: `http://127.0.0.1:${other.port}/other`,
      keepLook: false,
    });
    expect(await lookOf(core, otherId)).toBeNull();
    expect(stand.asked).toHaveLength(2);
  });

  test("one that failed says why and is made when the User tries again", async () => {
    const site = await startSite();
    let failure: WebPageLookFailure | null = "timed-out";
    const stand = standInLook(() => failure);
    const core = startCore(await createTempDataFolder(), {
      ...site.adapters,
      pageLook: stand.look,
    });

    const id = await saved(core, { address: site.address, keepLook: true });
    await settled(core, id);
    expect(await lookOf(core, id)).toEqual({ status: "failed", failure: "timed-out" });

    failure = null;
    await core.keepWebPageLook(id);
    await settled(core, id);
    expect((await lookOf(core, id))?.status).toBe("saved");
    expect(stand.asked).toHaveLength(2);
  });

  test("in Local mode no look is made: keeping one says why and loads nothing, and it is made once the setting is off", async () => {
    const site = await startSite();
    const stand = standInLook();
    const core = startCore(await createTempDataFolder(), {
      ...site.adapters,
      pageLook: stand.look,
    });
    const id = await saved(core, { address: site.address });
    await core.setLocalOnly(true);

    await core.keepWebPageLook(id);

    expect(await lookOf(core, id)).toEqual({ status: "failed", failure: "local-mode" });
    expect(stand.asked).toEqual([]);

    await core.setLocalOnly(false);
    await core.keepWebPageLook(id);
    await settled(core, id);
    expect((await lookOf(core, id))?.status).toBe("saved");
    expect(stand.asked).toEqual([site.address]);
  });

  test("a page let through once in Local mode isn't loaded for its look either", async () => {
    const site = await startSite();
    const stand = standInLook();
    const core = startCore(await createTempDataFolder(), {
      ...site.adapters,
      pageLook: stand.look,
    });
    await core.setLocalOnly(true);

    const id = await saved(core, { address: site.address, keepLook: true, localModeOnce: true });

    expect(await lookOf(core, id)).toEqual({ status: "failed", failure: "local-mode" });
    expect(stand.asked).toEqual([]);
  });

  test("a look waiting when the app quit isn't made at the next start in Local mode", async () => {
    const site = await startSite();
    const dataDir = await createTempDataFolder();
    const first = startCore(dataDir, site.adapters);
    const id = await saved(first, { address: site.address });
    await first.setLocalOnly(true);
    first.close();
    const db = openDatabase(join(dataDir, DATABASE_FILE));
    try {
      db.run("UPDATE web_pages SET look_status = 'saving'");
    } finally {
      db.close();
    }

    const stand = standInLook();
    const second = startCore(dataDir, { ...site.adapters, pageLook: stand.look });
    await settled(second, id);

    expect(await lookOf(second, id)).toEqual({ status: "failed", failure: "local-mode" });
    expect(stand.asked).toEqual([]);
  });

  test("one being made when the app quit is made at the next start, with the setting off, as that page asked", async () => {
    const site = await startSite();
    const dataDir = await createTempDataFolder();
    const first = startCore(dataDir, site.adapters);
    const id = await saved(first, { address: site.address });
    first.close();
    const db = openDatabase(join(dataDir, DATABASE_FILE));
    try {
      db.run("UPDATE web_pages SET look_status = 'saving'");
    } finally {
      db.close();
    }

    const stand = standInLook();
    const second = startCore(dataDir, { ...site.adapters, pageLook: stand.look });
    await settled(second, id);
    expect((await lookOf(second, id))?.status).toBe("saved");
    expect(stand.asked).toEqual([site.address]);
  });

  test.each([
    ["fails", { failure: "stopped", message: "Synthetic late result." }],
    ["is made", { pdf: new TextEncoder().encode("%PDF-1.7 late") }],
  ] as const)(
    "closed while a look is made, one that %s late is kept nowhere and none waiting is started; the next start makes them",
    async (_ending, late) => {
      const web = await startWeb({
        "/a": () => ({ status: 200, body: REPORT }),
        "/b": () => ({ status: 200, body: REPORT }),
      });
      const [a, b] = ["a", "b"].map((name) => `http://127.0.0.1:${web.port}/${name}`);
      if (!a || !b) throw new Error("No addresses.");
      const dataDir = await createTempDataFolder();
      const rendered: string[] = [];
      let finish: (made: typeof late) => void = () => undefined;
      const pageLook: PageLook = {
        render: (address) => {
          rendered.push(address);
          if (rendered.length > 1) {
            return Promise.resolve({ failure: "stopped", message: "Rendered after close." });
          }
          return new Promise((resolve) => {
            finish = resolve;
          });
        },
      };
      const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
      const first = startCore(dataDir, { ...web.adapters, pageLook });
      const idA = await saved(first, { address: a, keepLook: true });
      await expect.poll(() => rendered.length).toBe(1);
      const idB = await saved(first, { address: b, keepLook: true });
      expect(rendered).toEqual([a]);

      first.close();
      finish(late);
      await nextTurn();
      await lateFileWork(dataDir);

      expect(rendered).toEqual([a]);
      expect(errors).not.toHaveBeenCalled();
      expect(
        queryDatabase<{ look_status: string; look_hash: string | null }>(
          dataDir,
          "SELECT look_status, look_hash FROM web_pages ORDER BY address",
        ),
      ).toEqual([
        { look_status: "saving", look_hash: null },
        { look_status: "saving", look_hash: null },
      ]);
      expect(existsSync(join(dataDir, "Web pages", "looks"))).toBe(false);

      const stand = standInLook();
      const second = startCore(dataDir, { ...web.adapters, pageLook: stand.look });
      await Promise.all([settled(second, idA), settled(second, idB)]);
      expect((await lookOf(second, idA))?.status).toBe("saved");
      expect((await lookOf(second, idB))?.status).toBe("saved");
      expect([...stand.asked].sort()).toEqual([a, b]);
    },
  );

  test("closed as the app starts, the clean-up of deleted pages leaves the closed storage alone", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const dataDir = await createTempDataFolder();
    const core = startCore(dataDir);
    core.close();
    await lateFileWork(dataDir);
    expect(errors).not.toHaveBeenCalled();
  });

  test("one made again after a quit, which the app quit during again, is given up, saying why", async () => {
    const site = await startSite();
    const dataDir = await createTempDataFolder();
    const first = startCore(dataDir, site.adapters);
    const id = await saved(first, { address: site.address });
    first.close();
    const db = openDatabase(join(dataDir, DATABASE_FILE));
    try {
      db.run("UPDATE web_pages SET look_status = 'saving', look_failure = 'resumed'");
    } finally {
      db.close();
    }

    const stand = standInLook();
    const second = startCore(dataDir, { ...site.adapters, pageLook: stand.look });
    expect(await lookOf(second, id)).toEqual({ status: "failed", failure: "stopped" });
    expect(stand.asked).toEqual([]);
  });

  test("fetched again, a page keeps the choice made at its save, whatever the setting says now", async () => {
    const site = await startSite();
    const stand = standInLook();
    const core = startCore(await createTempDataFolder(), {
      ...site.adapters,
      pageLook: stand.look,
    });
    const id = await saved(core, { address: site.address, keepLook: false });
    await core.updateSettings({ user: { keepWebPageLook: true } });
    site.change();
    await core.fetchWebPageAgain(id);
    await waitForProcessing(core, [id]);
    expect(await lookOf(core, id)).toBeNull();
    expect(stand.asked).toEqual([]);
  });

  test("deleted while its look is made: deleted permanently, the PDF isn't left behind; restored, it shows how it went", async () => {
    const site = await startSite();
    const dataDir = await createTempDataFolder();
    const releases: (() => void)[] = [];
    const pageLook: PageLook = {
      render: (address) =>
        new Promise((resolve) => {
          releases.push(() => resolve({ pdf: new TextEncoder().encode(`%PDF-1.7 ${address}`) }));
        }),
    };
    const core = startCore(dataDir, { ...site.adapters, pageLook });
    const looks = join(dataDir, "Web pages", "looks");

    const restored = await saved(core, { address: site.address, keepLook: true });
    await expect.poll(() => releases.length).toBe(1);
    await core.deleteDocument(restored);

    const other = await startWeb({ "/other": () => ({ status: 200, body: REPORT }) });
    const purged = await saved(core, {
      address: `http://127.0.0.1:${other.port}/other`,
      keepLook: true,
    });
    // The next render starts only after the previous write, status and cleanup finish (#1473).
    releases.shift()?.();
    await expect.poll(() => releases.length).toBe(1);
    await core.restore([{ kind: "document", id: restored }]);
    expect((await lookOf(core, restored))?.status).toBe("saved");

    await core.deleteDocument(purged);
    await core.deletePermanently([{ kind: "document", id: purged }]);
    site.change();
    await core.fetchWebPageAgain(restored);
    await waitForProcessing(core, [restored]);
    releases.shift()?.();
    await expect.poll(() => releases.length).toBe(1);
    expect(readdirSync(looks).filter((name) => name.endsWith(".pdf"))).toHaveLength(1);
    releases.shift()?.();
    await settled(core, restored);
    expect((await lookOf(core, restored))?.status).toBe("saved");
  });

  test("deleted permanently, its PDF goes with it", async () => {
    const site = await startSite();
    const dataDir = await createTempDataFolder();
    const core = startCore(dataDir, { ...site.adapters, pageLook: standInLook().look });
    const id = await saved(core, { address: site.address, keepLook: true });
    await settled(core, id);
    const look = await lookOf(core, id);
    if (look?.status !== "saved") throw new Error("Not saved.");
    const file = join(dataDir, "Web pages", look.path);

    await core.deleteDocument(id);
    expect(existsSync(file)).toBe(true);
    await core.deletePermanently([{ kind: "document", id }]);
    await expect.poll(() => existsSync(file)).toBe(false);
  });
});
