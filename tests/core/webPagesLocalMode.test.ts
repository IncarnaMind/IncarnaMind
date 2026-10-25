/**
 * Adding a web page by address in Local mode (#1614): nothing is fetched until the User lets this
 * one page go, and letting it go doesn't turn Local mode off. Through the core's public
 * interface, with a local test server that counts the requests it gets.
 */
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, onTestFinished, test } from "vitest";
import { createTempDataFolder, startCore } from "../helpers/core";
import { waitForProcessing } from "../helpers/documents";

const PAGE = `<!doctype html><html lang="en"><head><title>Tea notes</title></head><body><article><h1>Tea notes</h1><p>${"Tea was first grown in China, and spread to Europe through Portuguese merchants. ".repeat(12)}</p></article></body></html>`;

async function startSite() {
  const requests: string[] = [];
  const server = createServer((request, response) => {
    requests.push(decodeURIComponent(request.url ?? ""));
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end(PAGE);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  onTestFinished(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  const { port } = server.address() as AddressInfo;
  return { requests, url: (path: string) => `http://127.0.0.1:${port}${path}` };
}

const LIMITS = { webPages: { limits: { timeoutMs: 1_000, maxBytes: 100_000 } } };

describe("A web page by address in Local mode", { timeout: 30_000 }, () => {
  test("is not fetched: the result says why, with the site, and nothing reached it", async () => {
    const site = await startSite();
    const core = startCore(await createTempDataFolder(), LIMITS);
    await core.setLocalOnly(true);

    const result = await core.saveWebPage({ address: site.url("/tea") });

    expect(result).toMatchObject({
      outcome: "failed",
      address: site.url("/tea"),
      failure: { reason: "local-mode" },
    });
    expect(site.requests).toEqual([]);
    expect(await core.listDocuments()).toEqual([]);
  });

  test("an address with Chinese characters is held as well, and goes once the User lets it", async () => {
    const site = await startSite();
    const core = startCore(await createTempDataFolder(), LIMITS);
    await core.setLocalOnly(true);
    const address = site.url("/茶/历史");

    const held = await core.saveWebPage({ address });
    expect(held).toMatchObject({ outcome: "failed", failure: { reason: "local-mode" } });
    expect(site.requests).toEqual([]);

    const once = await core.saveWebPage({ address, localModeOnce: true });
    expect(once.outcome).toBe("saved");
    expect(site.requests).toEqual(["/茶/历史"]);
    // Local mode stays on.
    expect((await core.getEmbeddingSettings()).localOnly).toBe(true);
  });

  test("with Local mode off nothing changes: the page is fetched and saved", async () => {
    const site = await startSite();
    const core = startCore(await createTempDataFolder(), LIMITS);

    const result = await core.saveWebPage({ address: site.url("/tea") });

    expect(result.outcome).toBe("saved");
    expect(site.requests).toEqual(["/tea"]);
  });

  test("a page already added keeps working, and a page whose HTML the app has needs no fetch", async () => {
    const site = await startSite();
    const core = startCore(await createTempDataFolder(), LIMITS);
    const first = await core.saveWebPage({ address: site.url("/tea") });
    if (first.outcome !== "saved") throw new Error("Not saved.");
    await waitForProcessing(core, [first.document.id]);
    await core.setLocalOnly(true);
    const before = site.requests.length;

    const again = await core.saveWebPage({ address: site.url("/tea") });
    const open = await core.saveWebPage({ address: site.url("/open"), html: PAGE });

    expect(again).toMatchObject({ outcome: "saved", existing: true });
    expect(open.outcome).toBe("saved");
    expect(site.requests).toHaveLength(before);
    expect(await core.listDocuments()).toHaveLength(2);
  });

  test("Fetch again is held too, and goes once the User lets it", async () => {
    const site = await startSite();
    const core = startCore(await createTempDataFolder(), LIMITS);
    const first = await core.saveWebPage({ address: site.url("/tea") });
    if (first.outcome !== "saved") throw new Error("Not saved.");
    await waitForProcessing(core, [first.document.id]);
    await core.setLocalOnly(true);
    const before = site.requests.length;

    const held = await core.fetchWebPageAgain(first.document.id);
    expect(held).toMatchObject({ outcome: "failed", failure: { reason: "local-mode" } });
    expect(site.requests).toHaveLength(before);

    const once = await core.fetchWebPageAgain(first.document.id, { localModeOnce: true });
    expect(once.outcome).toBe("saved");
    expect(site.requests).toHaveLength(before + 1);
  });
});
