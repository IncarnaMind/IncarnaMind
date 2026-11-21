import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import type { SortingBatch } from "../src/core/agents/sorting";
import { type CoreBridge, NOT_IN_A_FOLDER_ID } from "../src/core/api";
import { translate } from "../src/shared/i18n";
import { legacyAgentClient } from "../tests/helpers/agentClients";
import {
  acceptPlainTextKeys,
  createDataFolder,
  dismissChatSetup,
  expectReadyDocuments,
  launchApp,
  motionSettled,
  pointAndClick,
  removeDataFolder,
  runCommand,
  setLanguage,
  setWindowSize,
  urlsOpened,
} from "./app";

for (const [language, width] of [
  ["en", 1440],
  ["zh-CN", 900],
] as const) {
  test(`${language}: a connected agent's sorting suggestion names its author and waits for Confirm`, async () => {
    const data = await createDataFolder();
    const source = await createDataFolder();
    const { app, window } = await launchApp(data);
    try {
      await dismissChatSetup(window);
      await acceptPlainTextKeys(window);
      await setWindowSize(app, window, width, 820);
      await setLanguage(window, language);
      const file = join(source, "Field notes.md");
      await writeFile(
        file,
        "The outer reef was exposed at low tide. Record the range in the spring tide survey.",
      );
      const { root, folder } = await window.evaluate(async (path) => {
        const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
        const root = await core.createLibraryGroup({ name: "Fieldwork", description: "" });
        const folder = await core.createLibraryGroup({
          name: "Coast",
          description: "",
          parentId: root.id,
        });
        await core.addDocuments([path]);
        return { root: root.id, folder: folder.id };
      }, file);
      await expectReadyDocuments(window, 1);
      const shots = process.env.INCARNAMIND_SCREENSHOTS;
      await runCommand(window, "library.open", translate(language, "library.open"));
      const organize = window.getByTestId("library-organize");
      await pointAndClick(window, organize);
      await expect(window.getByTestId("library-organize-needs-model")).toBeVisible();
      if (shots) {
        await mkdir(shots, { recursive: true });
        await motionSettled(window);
        await window.screenshot({ path: join(shots, `setup-${language}-${width}.png`) });
      }
      await pointAndClick(window, window.getByTestId("library-organize-dismiss"));
      const second = await window.evaluate(async (root) => {
        const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
        await core.setAgentsEnabled(true);
        return (
          await core.connectAgent({ name: "Second reader", client: "vscode", folderIds: [root] })
        ).pairing.id;
      }, root);
      await pointAndClick(window, organize);
      await expect(window.getByTestId("library-organize-agent")).toContainText(
        translate(language, "library.organize.share"),
      );
      await pointAndClick(window, window.getByTestId("library-organize-dismiss"));
      const launch = await window.evaluate(
        async ({ root, loose, second }) => {
          const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
          await core.updateAgent(second, { folderIds: [loose] });
          return (
            await core.connectAgent({
              name: "Field assistant",
              client: "claude-code",
              folderIds: [root, loose],
            })
          ).launch;
        },
        { root, loose: NOT_IN_A_FOLDER_ID, second },
      );
      await expect(organize).toHaveText(
        translate(language, "library.organize.withAgent", { agent: "Field assistant" }),
      );
      await pointAndClick(window, window.getByTestId("library-organize-others"));
      await expect(
        window.getByRole("menuitem", {
          name: translate(language, "library.organize.withAgent", { agent: "Second reader" }),
        }),
      ).toBeVisible();
      await window.keyboard.press("Escape");
      if (shots) {
        await mkdir(shots, { recursive: true });
        await motionSettled(window);
        await window.screenshot({ path: join(shots, `before-${language}-${width}.png`) });
      }
      await pointAndClick(window, organize);
      await expect.poll(() => urlsOpened(app)).toHaveLength(1);
      expect(new URL((await urlsOpened(app))[0] ?? "about:blank").searchParams.get("q")).toBe(
        translate(language, "agents.ask.line.organize"),
      );
      const agent = await legacyAgentClient(launch);
      try {
        const batch = await agent.callTool({ name: "list_sorting", arguments: {} });
        const doc = (batch.structuredContent as unknown as SortingBatch).documents[0];
        if (!doc) throw new Error("Expected a waiting Document");
        const request = await agent.callTool({ name: "read_request", arguments: {} });
        expect(request.structuredContent).toMatchObject({
          request: expect.stringContaining(doc.id),
        });
        const sent = await agent.callTool({
          name: "propose_sorting",
          arguments: {
            proposals: [{ documentId: doc.id, version: doc.version, folderId: folder }],
          },
        });
        expect(sent.structuredContent).toEqual({ waiting: 1 });
      } finally {
        await agent.close();
      }
      const before = await window.evaluate(async () => {
        const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
        return {
          folders: (await core.getLibrary()).assignments.map((a) => a.groupId),
          usage: (await core.getCostSummary()).providers.map((p) => p.requests),
        };
      });
      expect(before.folders).not.toContain(folder);
      expect(before.usage.reduce((sum, n) => sum + n, 0)).toBe(0);
      await runCommand(window, "library.review", translate(language, "library.review.open"));
      const row = window.getByTestId("organize-review-row");
      await expect(row).toContainText("Field notes");
      await expect(row).toContainText(
        translate(language, "organizeReview.agent", { agent: "Field assistant" }),
      );
      if (shots) {
        await motionSettled(window);
        await window.screenshot({ path: join(shots, `sorting-${language}-${width}.png`) });
      }
      await pointAndClick(window, window.getByTestId("organize-review-confirm"));
      await expect
        .poll(() =>
          window.evaluate(async () => {
            const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
            return (await core.getLibrary()).assignments.map((a) => a.groupId);
          }),
        )
        .toContain(folder);
    } finally {
      await app.close();
      await removeDataFolder(data);
      await removeDataFolder(source);
    }
  });
}
