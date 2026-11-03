/** Run after `npm run dist`; launches the real artifact with disposable data. */
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { type ElectronApplication, _electron as electron, expect, test } from "@playwright/test";
import { launchEnvironment } from "../../e2e/launchEnvironment";
import type { CoreBridge } from "../../src/core/api";
import { homeEnv } from "../../tests/helpers/home";
import { buildPdf } from "../../tests/helpers/pdf";

test("production packaged Library renders and classifies an image-only PDF", async () => {
  const executablePath = resolve(
    process.env.INCARNAMIND_PACKAGED_EXECUTABLE ??
      "dist/mac-arm64/IncarnaMind.app/Contents/MacOS/IncarnaMind",
  );
  const dataDir = await mkdtemp(join(tmpdir(), "incarnamind-packaged-"));
  const home = await mkdtemp(join(tmpdir(), "incarnamind-packaged-home-"));
  const requests: { model: string; images?: string[] }[] = [];
  const server = createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    response.setHeader("content-type", "application/json");
    if (request.url === "/api/tags")
      response.end(JSON.stringify({ models: [{ name: "clef-flash:latest" }] }));
    else if (request.url === "/api/ps") response.end(JSON.stringify({ models: [] }));
    else if (request.url === "/v1/systemone") {
      const body = JSON.parse(raw);
      requests.push(body);
      response.end(
        JSON.stringify({
          answers: Object.fromEntries(
            Object.keys(body.questions).map((id) => [
              id,
              id === "group"
                ? { type: "choice", choice: "__unsorted__" }
                : { type: "noul", noul: 0.01 },
            ]),
          ),
        }),
      );
    } else {
      response.statusCode = 404;
      response.end();
    }
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  // The flag suppresses update checks. This production build has no fake embedder/chat.
  const env = launchEnvironment({
    ...homeEnv(home),
    INCARNAMIND_DATA_DIR: dataDir,
    INCARNAMIND_TEST_HOOKS: "1",
  });
  let app: ElectronApplication | undefined;
  try {
    // The fresh test profile has no credentials; keep macOS Keychain out of this
    // packaging check instead of prompting for access to the user's real key.
    app = await electron.launch({ executablePath, env, args: ["--use-mock-keychain"] });
    assert.equal(await app.evaluate(({ app }) => app.isPackaged), true);
    const window = await app.firstWindow();
    await window.getByTestId("new-mind").waitFor();
    assert.ok(window.url().startsWith("file:"));
    const later = window.getByTestId("chat-setup-later");
    if (await later.isVisible()) await later.click();
    const file = join(dataDir, "scan.pdf");
    await writeFile(file, buildPdf([{ image: true }]));
    const id = await window.evaluate(
      async ({ file, baseUrl }) => {
        const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
        await core.createLibraryGroup({ name: "Research", description: "Research papers" });
        await core.saveLibrarySettings({ classifier: { kind: "auto", baseUrl }, automatic: true });
        return (await core.addDocuments([file])).documents[0]?.id;
      },
      { file, baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}` },
    );
    assert.ok(id);
    await expect
      .poll(
        () =>
          window.evaluate(async (id) => {
            const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
            return (await core.getLibrary()).assignments.find((row) => row.documentId === id);
          }, id),
        { timeout: 60_000 },
      )
      .toMatchObject({
        status: "classified",
        model: { id: "clef-flash", images: true, reason: "visual" },
      });
    assert.equal(requests.length, 1);
    assert.equal(requests[0]?.model, "clef-flash");
    assert.equal(requests[0]?.images?.length, 1);
    assert.deepEqual(
      Buffer.from(requests[0]?.images?.[0] ?? "", "base64").subarray(0, 3),
      Buffer.from([255, 216, 255]),
    );
    await window.getByTestId("open-library").click();
    await expect(window.getByTestId("library")).toBeVisible();
    await window.screenshot({ path: "/tmp/incarnamind-packaged-library.png" });
    console.log(
      "PASS: production packaged app, migrations, PDF extraction, native canvas worker, Auto visual route, Library UI.",
    );
  } finally {
    try {
      await app?.close();
    } finally {
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
      await rm(dataDir, { recursive: true, force: true, maxRetries: 3 });
      await rm(home, { recursive: true, force: true, maxRetries: 3 });
    }
  }
});
