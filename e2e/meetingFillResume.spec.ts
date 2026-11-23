import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { type ElectronApplication, expect, test } from "@playwright/test";
import type { CoreBridge } from "../src/core/api";
import {
  createDataFolder,
  dismissChatSetup,
  firstTranscriptLine,
  launchApp,
  pointAndClick,
  recordMeeting,
  removeDataFolder,
  startRecording,
} from "./app";

test("reopening a stopped Meeting resumes its unwritten notes and Stop cancels that request", async () => {
  const dataDir = await createDataFolder();
  let requested = 0;
  const server = createServer((request, response) => {
    request.resume();
    if (request.url === "/api/tags") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ models: [{ name: "fake-model", model: "fake-model" }] }));
    } else if (request.url?.endsWith("/chat/completions") || request.url === "/api/chat") {
      requested++;
    } else {
      response.writeHead(404).end();
    }
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const options = { ollama: url, transcriber: { lines: ["We agreed to meet on Friday."] } };
  let app: ElectronApplication | undefined;
  try {
    const first = await launchApp(dataDir, options);
    app = first.app;
    await dismissChatSetup(first.window);
    await first.window.evaluate(async (baseUrl) => {
      const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
      await core.saveChatProvider({ kind: "ollama", modelId: "fake-model", baseUrl });
    }, url);
    const bar = await startRecording(first.window, await recordMeeting(first.window), {
      notice: true,
    });
    await firstTranscriptLine(first.window);
    await pointAndClick(first.window, bar.getByTestId("meeting-stop"));
    await expect(first.window.getByTestId("meeting-fill-stop")).toBeVisible();
    await expect.poll(() => requested).toBe(1);
    await app.close();
    app = undefined;
    const resumed = await launchApp(dataDir, options);
    app = resumed.app;
    await expect.poll(() => requested).toBe(2);
    await dismissChatSetup(resumed.window);
    const mindId = await resumed.window.evaluate(async () => {
      const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
      return (await core.listMeetings())[0]?.mindId;
    });
    const note = resumed.window
      .locator(`[data-testid="mind-row"][data-mind-id="${mindId}"]`)
      .first();
    await pointAndClick(resumed.window, note);
    await pointAndClick(resumed.window, resumed.window.getByTestId("meeting-fill-stop"));
    await expect(resumed.window.getByTestId("meeting-fill-again")).toBeVisible();
    await expect(resumed.window.getByTestId("meeting-fill-stop")).toHaveCount(0);
    const fill = await resumed.window.evaluate(async () => {
      const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
      return (await bridge.listMeetings())[0]?.fill;
    });
    expect(fill).toMatchObject({
      state: "failed",
      problem: { kind: "user-stopped" },
      addedBlockIds: [],
    });
  } finally {
    await app?.close();
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
    await removeDataFolder(dataDir);
  }
});
