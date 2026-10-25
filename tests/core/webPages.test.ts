/**
 * Web pages saved as Documents (#261), fetched from a local test server:
 * named by their title, cited by section and paragraph, checked against the
 * snapshot, fetched again as new versions, and refused, saying why, when
 * they can't be fetched or are mostly not text.
 */
import { existsSync, readFileSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { describe, expect, onTestFinished, test } from "vitest";
import type { Core, WebPageResult } from "../../src/core";
import { citationState } from "../../src/shared/citations";
import {
  askAndFinish,
  citingModel,
  onlyCitation,
  type ShownPassage,
  setUpWithDocuments,
} from "../helpers/citations";
import { createTempDataFolder, queryDatabase, startCore, tickingClock } from "../helpers/core";
import { waitForProcessing } from "../helpers/documents";

const fixture = (name: string) => readFileSync(new URL(`../fixtures/web/${name}`, import.meta.url));

const ARTICLE = fixture("article.html");
const PORTUGUESE =
  "Tea was first introduced to Portuguese priests and merchants in China during the 16th century";

/** A page whose History section says another thing, as the live page may come to. */
const REWRITTEN = Buffer.from(
  ARTICLE.toString("utf8").replace(
    "Tea was first introduced to Portuguese priests and merchants in China during the 16th century",
    "Portuguese traders first met tea in Macau late in the 16th century",
  ),
);

/** The test server's pages; `/changing` serves whatever `live.page` holds. */
async function startSite() {
  const live = { page: ARTICLE, requests: 0 };
  const html = (response: ServerResponse, body: Buffer, type = "text/html; charset=utf-8") => {
    response.writeHead(200, { "Content-Type": type, "Content-Length": body.byteLength });
    response.end(body);
  };
  const server = createServer((request, response) => {
    live.requests++;
    switch (request.url) {
      case "/tea":
        return html(response, ARTICLE);
      case "/changing":
        return html(response, live.page);
      case "/cha":
        return html(response, fixture("chinese-gbk.html"), "text/html");
      case "/members":
        return html(response, fixture("login.html"));
      case "/video":
        return html(response, fixture("video.html"));
      case "/app":
        return html(response, fixture("app.html"));
      case "/old-tea":
        response.writeHead(301, { Location: "/tea" });
        return response.end();
      case "/private":
        response.writeHead(403);
        return response.end("Forbidden");
      case "/paper.pdf":
        return html(response, Buffer.from("%PDF-1.7\n"), "application/pdf");
      case "/slow":
        return; // never answers
      case "/huge":
        response.writeHead(200, { "Content-Type": "text/html" });
        response.write(`<html><body>${"<p>tea </p>".repeat(20_000)}`);
        return response.end("</body></html>");
      default:
        response.writeHead(404);
        return response.end("Not found");
    }
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
  return { live, url: (path: string) => `http://127.0.0.1:${port}${path}` };
}

/** Fetches within a second and 100 KB in tests, so nothing waits on the real limits. */
const LIMITS = { webPages: { limits: { timeoutMs: 1_000, maxBytes: 100_000 } } };

async function saved(core: Core, input: Parameters<Core["saveWebPage"]>[0]) {
  const result = await core.saveWebPage(input);
  if (result.outcome !== "saved") throw new Error(`Not saved: ${JSON.stringify(result)}`);
  const [processed] = await waitForProcessing(core, [result.document.id]);
  if (!processed) throw new Error("It went.");
  return { result, document: processed };
}

/** A model that searches for `query` and quotes `quote` from the first Passage found. */
const quoting = (query: string, quote: string) =>
  citingModel({
    query,
    records: (passages: ShownPassage[]) => [{ marker: 1, passage: passages[0]?.id, quote }],
    answer: "Tea reached Europe through Portuguese merchants [^1].",
  });

describe("Saving a web page", { timeout: 30_000 }, () => {
  test("its address becomes a Web page Document named by its title, its snapshot in the data folder", async () => {
    const site = await startSite();
    const dataDir = await createTempDataFolder();
    const core = startCore(dataDir, LIMITS);

    const { result, document } = await saved(core, { address: site.url("/tea#History") });

    expect(result.existing).toBe(false);
    expect(document).toMatchObject({
      kind: "web",
      name: "Tea - The Open Encyclopedia",
      status: "ready",
      fileStatus: "available",
      linkedFolderId: null,
      creationDate: "2024-05-01T09:30:00+01:00",
      web: {
        address: site.url("/tea"),
        siteName: "The Open Encyclopedia",
        author: "Ann Lee",
        published: "2024-05-01T09:30:00+01:00",
      },
    });
    // Its reference record, for citing it, is read from the snapshot.
    expect(document.reference?.fields).toMatchObject({
      type: "webpage",
      title: "Tea - The Open Encyclopedia",
      authors: [{ family: "Lee", given: "Ann" }],
      issued: "2024-05-01",
      containerTitle: "The Open Encyclopedia",
      url: site.url("/tea"),
    });
    expect(document.path).toBe(join(dataDir, "Web pages", `${document.id}.html`));
    expect(readFileSync(document.path, "utf8")).not.toMatch(/<script|onclick|src=/);
    expect(await core.searchPassages("Portuguese merchants", { mode: "keyword" })).toHaveLength(1);
  });

  test("a Question about it is answered with a Citation to a section and paragraph, its quote found", async () => {
    const site = await startSite();
    const { core, client, mind } = await setUpWithDocuments(
      quoting("Portuguese merchants", PORTUGUESE),
      [],
      LIMITS,
    );
    const { document } = await saved(core, { address: site.url("/tea") });

    const { answerId } = await askAndFinish(core, client, mind.id, "How did tea reach Europe?");

    expect(onlyCitation(client, answerId)).toMatchObject({
      documentId: document.id,
      documentName: "Tea - The Open Encyclopedia",
      contentHash: document.contentHash,
      location: { kind: "section", heading: "History", paragraphs: { from: 2, to: 2 } },
      quote: PORTUGUESE,
      check: "found",
    });
  });

  test("a Chinese page in GBK is read, named by its heading and searchable by its words", async () => {
    const site = await startSite();
    const core = startCore(await createTempDataFolder(), LIMITS);

    const { document } = await saved(core, { address: site.url("/cha") });

    expect(document).toMatchObject({ name: "茶的历史", web: { siteName: "茶文化网" } });
    const found = await core.searchPassages("陆羽", { mode: "keyword" });
    expect(found).toHaveLength(1);
    expect(found[0]?.text).toContain("陆羽撰写了《茶经》");
  });

  test("an address saved already gives its Document; a redirect is followed; HTML given is saved without a fetch", async () => {
    const site = await startSite();
    const core = startCore(await createTempDataFolder(), LIMITS);
    const { document } = await saved(core, { address: site.url("/tea") });

    const again = await core.saveWebPage({ address: site.url("/tea") });
    expect(again).toMatchObject({
      outcome: "saved",
      existing: true,
      document: { id: document.id },
    });

    const moved = await saved(core, { address: site.url("/old-tea") });
    expect(moved.document.id).not.toBe(document.id);
    expect(moved.document.web?.address).toBe(site.url("/old-tea"));

    const before = site.live.requests;
    const given = await saved(core, {
      address: "https://reader.example/tea",
      html: ARTICLE.toString("utf8"),
    });
    expect(site.live.requests).toBe(before);
    expect(given.document).toMatchObject({
      name: "Tea - The Open Encyclopedia",
      web: { address: "https://reader.example/tea" },
    });
  });

  test("filed in a Folder, it is in that Folder", async () => {
    const site = await startSite();
    const core = startCore(await createTempDataFolder(), LIMITS);
    const folder = await core.createLibraryGroup({ name: "Reading", description: "" });

    const { document } = await saved(core, { address: site.url("/tea"), folderId: folder.id });

    const { assignments } = await core.getLibrary();
    expect(assignments.find((each) => each.documentId === document.id)).toMatchObject({
      groupId: folder.id,
      source: "user",
    });
    await expect(
      core.saveWebPage({ address: site.url("/cha"), folderId: "no-such-folder" }),
    ).rejects.toThrow("That Folder doesn’t exist or has been deleted.");
  });

  test("a page that can't be fetched, or is mostly not text, says why, and nothing is added", async () => {
    const site = await startSite();
    const core = startCore(await createTempDataFolder(), LIMITS);
    const reasons: Record<string, string> = {};
    for (const [address, path] of [
      ["members", site.url("/members")],
      ["private", site.url("/private")],
      ["missing", site.url("/missing")],
      ["slow", site.url("/slow")],
      ["huge", site.url("/huge")],
      ["pdf", site.url("/paper.pdf")],
      ["video", site.url("/video")],
      ["app", site.url("/app")],
      ["closed", "http://127.0.0.1:1/tea"],
      ["ftp", "ftp://files.example/tea.html"],
      ["script", "javascript:alert(1)"],
    ] as const) {
      const result: WebPageResult = await core.saveWebPage({ address: path });
      reasons[address] = result.outcome === "failed" ? result.failure.reason : "saved";
    }

    expect(reasons).toEqual({
      members: "needs-sign-in",
      private: "needs-sign-in",
      missing: "not-found",
      slow: "timed-out",
      huge: "too-large",
      pdf: "not-a-page",
      video: "video",
      app: "not-text",
      closed: "unreachable",
      ftp: "invalid-address",
      script: "invalid-address",
    });
    expect(await core.listDocuments()).toEqual([]);
  });
});

describe("Fetching a web page again", { timeout: 30_000 }, () => {
  test("a changed page is a new version; a Citation of the old one still checks against it", async () => {
    const site = await startSite();
    const { core, client, mind, dataDir } = await setUpWithDocuments(
      quoting("Portuguese merchants", PORTUGUESE),
      [],
      LIMITS,
    );
    const { document } = await saved(core, { address: site.url("/changing") });
    const { answerId } = await askAndFinish(core, client, mind.id, "How did tea reach Europe?");
    const citation = onlyCitation(client, answerId);
    expect(citation).toMatchObject({ check: "found", contentHash: document.contentHash });

    site.live.page = REWRITTEN;
    const fetched = await core.fetchWebPageAgain(document.id);
    expect(fetched).toMatchObject({ outcome: "saved", existing: true });
    const [changed] = await waitForProcessing(core, [document.id]);
    expect(changed?.contentHash).not.toBe(document.contentHash);
    expect(changed?.web?.versions.map((each) => each.contentHash)).toEqual([
      changed?.contentHash,
      document.contentHash,
    ]);

    // The Citation stands for the version it quoted, whose text is kept; the new one hasn't the quote.
    expect(citationState(citation, await core.listDocuments())).toMatchObject({
      check: "found",
      changedAfterCited: true,
    });
    expect(
      queryDatabase(
        dataDir,
        "SELECT 1 FROM document_pages WHERE content_hash = ? AND deleted_at IS NULL",
        [document.contentHash],
      ).length,
    ).toBeGreaterThan(0);
    expect(
      await core.recheckCitation({
        documentId: document.id,
        quote: PORTUGUESE,
        pageFrom: citation.pageFrom,
        pageTo: citation.pageTo,
      }),
    ).toMatchObject({ check: "not-found" });
  });

  test("an unchanged page stays the same version, fetched later; one that can't be fetched now leaves it as it was", async () => {
    const site = await startSite();
    const core = startCore(await createTempDataFolder(), { ...LIMITS, now: tickingClock() });
    const { document } = await saved(core, { address: site.url("/changing") });

    const again = await core.fetchWebPageAgain(document.id);
    if (again.outcome !== "saved") throw new Error("Not fetched.");
    expect(again.document.contentHash).toBe(document.contentHash);
    expect(again.document.web?.versions).toHaveLength(1);
    expect((again.document.web?.fetchedAt ?? "") > (document.web?.fetchedAt ?? "")).toBe(true);

    site.live.page = Buffer.from(
      readFileSync(new URL("../fixtures/web/login.html", import.meta.url)),
    );
    expect(await core.fetchWebPageAgain(document.id)).toMatchObject({
      outcome: "failed",
      failure: { reason: "needs-sign-in" },
    });
    expect((await core.listDocuments())[0]).toMatchObject({
      id: document.id,
      contentHash: document.contentHash,
      status: "ready",
    });
    await expect(core.fetchWebPageAgain("no-such-document")).rejects.toThrow();
  });
});

describe("Deleting a web page", { timeout: 30_000 }, () => {
  test("restored, it is the web page it was; deleted permanently, its snapshot goes too", async () => {
    const site = await startSite();
    const dataDir = await createTempDataFolder();
    const core = startCore(dataDir, LIMITS);
    const { document } = await saved(core, { address: site.url("/tea") });

    await core.deleteDocument(document.id);
    await core.restore([{ kind: "document", id: document.id }]);
    const [restored] = await core.listDocuments();
    expect(restored).toMatchObject({
      id: document.id,
      kind: "web",
      web: { address: site.url("/tea"), siteName: "The Open Encyclopedia" },
    });

    await core.deleteDocument(document.id);
    await core.deletePermanently([{ kind: "document", id: document.id }]);
    expect(existsSync(document.path)).toBe(false);
    expect(
      queryDatabase(dataDir, "SELECT 1 FROM web_pages WHERE document_id = ?", [document.id]),
    ).toEqual([]);
  });
});
