/**
 * A saved web page keeps its article's pictures (#756), fetched from a stand-in
 * web on this computer: saved by their content and shown from the page's own
 * files; an ad, a tracking pixel, an avatar, an icon and a picture on this
 * computer's network left out; the caps kept, saying how many were left out;
 * nothing fetched but the page and its article's pictures; and the files
 * going with the page when it is deleted permanently.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createCanvas } from "@napi-rs/canvas";
import { describe, expect, test } from "vitest";
import type { Core } from "../../src/core";
import { PICTURE_LIMITS } from "../../src/core/documents/web/pictures";
import { createTempDataFolder, queryDatabase, startCore } from "../helpers/core";
import { waitForProcessing } from "../helpers/documents";
import { startWeb, type WebRoute } from "../helpers/web";

const REPORT = readFileSync(new URL("../fixtures/web/report.html", import.meta.url));

/** A picture of `width` × `height` with a line of text, as PNG or JPEG. */
function picture(width: number, height: number, type: "image/png" | "image/jpeg"): Buffer {
  const canvas = createCanvas(width, height);
  const context = canvas.getContext("2d");
  context.fillStyle = "#fff";
  context.fillRect(0, 0, width, height);
  context.fillStyle = "#000";
  context.font = "24px sans-serif";
  context.fillText("Revenue 2026", 20, 40);
  return type === "image/png" ? canvas.toBuffer("image/png") : canvas.toBuffer("image/jpeg");
}

const CHART = picture(400, 300, "image/png");
const BERTH = picture(640, 480, "image/jpeg");
const ICON = picture(32, 32, "image/png");

const served =
  (body: Uint8Array, type: string): (() => WebRoute) =>
  () => ({ status: 200, headers: { "Content-Type": type }, body });

/** The stand-in web: the report, its pictures, an ad, a pixel, an avatar and an icon. */
async function startSite(routes: Record<string, () => WebRoute> = {}) {
  return startWeb({
    "/report": () => ({ status: 200, body: REPORT }),
    "/charts/revenue.png": served(CHART, "image/png"),
    "/harbour/berth.jpg": served(BERTH, "image/jpeg"),
    "/banner.png": served(CHART, "image/png"),
    "/pixel.gif": served(ICON, "image/gif"),
    "/avatar.jpg": served(BERTH, "image/jpeg"),
    "/thumbs/up.png": served(ICON, "image/png"),
    "/internal/map.png": served(CHART, "image/png"),
    ...routes,
  });
}

async function saved(core: Core, address: string) {
  const result = await core.saveWebPage({ address });
  if (result.outcome !== "saved") throw new Error(`Not saved: ${JSON.stringify(result)}`);
  const [processed] = await waitForProcessing(core, [result.document.id]);
  if (!processed) throw new Error("It went.");
  return processed;
}

describe("A web page's pictures", { timeout: 30_000 }, () => {
  test("the article's pictures are saved by their content and shown in place, from any image server; an ad, a pixel, an avatar, an icon and one on this computer's network aren't, and nothing else is fetched", async () => {
    const web = await startSite();
    const dataDir = await createTempDataFolder();
    const core = startCore(dataDir, web.adapters);

    const page = await saved(core, `http://127.0.0.1:${web.port}/report`);
    const snapshot = readFileSync(page.path, "utf8");
    const pictures = queryDatabase<{ number: number; picture_hash: string; media_type: string }>(
      dataDir,
      `SELECT number, picture_hash, media_type FROM web_page_pictures
       WHERE document_id = ? AND deleted_at IS NULL ORDER BY number`,
      [page.id],
    );
    expect(pictures).toEqual([
      { number: 1, picture_hash: expect.any(String), media_type: "image/png" },
      { number: 2, picture_hash: expect.any(String), media_type: "image/jpeg" },
    ]);
    const [chart, berth] = pictures;
    // In place, from its own file, its size given; no picture's web address in the snapshot.
    expect(snapshot).toContain(
      `<img alt="Revenue by quarter" src="pictures/${chart?.picture_hash}.png" width="400" height="300"/>`,
    );
    expect(snapshot).toContain(
      `<img alt="The new deep-water berth at dawn" src="pictures/${berth?.picture_hash}.jpg" width="640" height="480"/>`,
    );
    expect(snapshot).not.toMatch(/revenue\.png|berth\.jpg|banner|pixel|avatar|up\.png|map\.png/);
    // The files are the pictures, named by their content.
    const folder = join(dataDir, "Web pages", "pictures");
    expect(readFileSync(join(folder, `${chart?.picture_hash}.png`))).toEqual(CHART);
    expect(readFileSync(join(folder, `${berth?.picture_hash}.jpg`))).toEqual(BERTH);
    expect(page.web?.picturesLeftOut).toBe(0);

    // Only the page and its article's pictures were asked for: no ad, pixel, avatar or logo,
    // and nothing on this computer. The icon was fetched, being of no stated size, and not kept.
    expect([...web.heard].sort()).toEqual([
      `127.0.0.1:${web.port}/report`,
      "cdn.photos.example/harbour/berth.jpg",
      "images.news.example/charts/revenue.png",
      "news.example/thumbs/up.png",
    ]);

    // Shown from the page's own files, and only those.
    const shown = await core.openDocumentImage(page.id, `pictures/${chart?.picture_hash}.png`);
    expect(shown).toMatchObject({ type: "image/png", size: CHART.byteLength });
    await shown.stream.cancel();
    for (const path of [
      `pictures/${"0".repeat(64)}.png`,
      `pictures/../${page.id}.html`,
      "../Web pages/pictures/x.png",
    ]) {
      await expect(core.openDocumentImage(page.id, path)).rejects.toThrow();
    }
  });

  test("over the caps the first pictures are kept, and the page says how many were left out", async () => {
    const web = await startSite();
    const dataDir = await createTempDataFolder();
    const core = startCore(dataDir, {
      ...web.adapters,
      webPages: { fetch, pictureLimits: { ...PICTURE_LIMITS, maxCount: 1 } },
    });

    const page = await saved(core, `http://127.0.0.1:${web.port}/report`);
    expect(page.web?.picturesLeftOut).toBe(1);
    expect(
      queryDatabase(dataDir, "SELECT number FROM web_page_pictures WHERE document_id = ?", [
        page.id,
      ]),
    ).toEqual([{ number: 1 }]);
    expect(readFileSync(page.path, "utf8")).toContain(
      '<img alt="The new deep-water berth at dawn"/>',
    );

    // A picture over its own limit is left out too.
    expect(CHART.byteLength).not.toBe(BERTH.byteLength);
    const strict = startCore(await createTempDataFolder(), {
      ...web.adapters,
      webPages: {
        fetch,
        pictureLimits: {
          ...PICTURE_LIMITS,
          maxBytes: Math.min(CHART.byteLength, BERTH.byteLength),
        },
      },
    });
    const other = await saved(strict, `http://127.0.0.1:${web.port}/report`);
    expect(other.web?.picturesLeftOut).toBe(1);
  });

  test("fetched again unchanged, it is the same version with the same pictures; deleted permanently, its pictures go", async () => {
    const web = await startSite();
    const dataDir = await createTempDataFolder();
    const core = startCore(dataDir, web.adapters);
    const page = await saved(core, `http://127.0.0.1:${web.port}/report`);
    const files = () =>
      queryDatabase<{ picture_hash: string; media_type: string }>(
        dataDir,
        "SELECT DISTINCT picture_hash, media_type FROM web_page_pictures",
      ).map((row) =>
        join(
          dataDir,
          "Web pages",
          "pictures",
          `${row.picture_hash}.${row.media_type === "image/png" ? "png" : "jpg"}`,
        ),
      );
    const before = files();
    expect(before).toHaveLength(2);

    const again = await core.fetchWebPageAgain(page.id);
    expect(again.outcome).toBe("saved");
    expect((await core.listDocuments())[0]?.web?.versions).toHaveLength(1);
    expect(
      queryDatabase(dataDir, "SELECT 1 FROM web_page_pictures WHERE document_id = ?", [page.id]),
    ).toHaveLength(2);

    await core.deleteDocument(page.id);
    for (const file of before) expect(existsSync(file)).toBe(true);
    await core.deletePermanently([{ kind: "document", id: page.id }]);
    for (const file of before) expect(existsSync(file)).toBe(false);
  });
});
