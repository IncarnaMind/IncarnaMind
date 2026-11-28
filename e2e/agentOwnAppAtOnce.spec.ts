import { realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { expect, type Page, test } from "@playwright/test";
import type { Editor } from "@tiptap/core";
import type { AgentLaunch, CoreBridge } from "../src/core/api";
import { SHOW_AGENT_CONNECTION } from "../src/shared/agentConnection";
import { translate } from "../src/shared/i18n";
import { buildPdf } from "../tests/helpers/pdf";
import {
  acceptPlainTextKeys,
  addDocuments,
  checkNote,
  useLocalChatModel as connectLocalChatModel,
  createDataFolder,
  dismissChatSetup,
  enterContent,
  expectReadyDocuments,
  frontMind,
  launchApp,
  nameMind,
  newMind,
  noteCheck,
  pointAndClick,
  removeDataFolder,
  setLanguage,
  setWindowSize,
} from "./app";

test.skip(!SHOW_AGENT_CONNECTION, "Your AI is hidden while SHOW_AGENT_CONNECTION is false.");

/*
 * Outside-app AI changes to the User's own Note (#3839):
 * - Single-threaded mounted-editor accept, lossless typing guard (`changedByUser`) including
 *   concurrent typing during an in-flight write, and Chinese IME composition
 *   (`Input.imeSetComposition` -> `view.composing === true`) refusal on both the same paragraph and
 *   another paragraph with 0 words or IME text lost.
 * - >50% User-text rewrites hold with `Apply · Discard` (no `Accept all · Reject all`), including
 *   after closing and reopening the Note; Apply saves a Checkpoint and lands the change.
 * - Front tab shows only the inline applied-edit line (no sidebar footer notice); hidden tab and
 *   closed Note keep the sidebar footer notice with Open and draw the inline line with 1-step Undo
 *   (including keyboard `ControlOrMeta+z`).
 * - Editing an already-checked User Note immediately updates `#3866` `uncheckedBlocks` so the Check
 *   button flips from Checked / 已核对 back to unchecked.
 */

let dataDir: string;
let sources: string;
let home: string;
test.beforeEach(async () => {
  dataDir = await createDataFolder();
  sources = await realpath(await createDataFolder());
  home = await realpath(await createDataFolder());
});
test.afterEach(async () => {
  await removeDataFolder(dataDir);
  await removeDataFolder(sources);
  await removeDataFolder(home);
});

async function connectAgent(
  window: Page,
  folderName: string,
  sourcePath: string,
): Promise<{ folderId: string; launch: AgentLaunch }> {
  const made = await window.evaluate(
    async ({ name, path }) => {
      const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
      const folder = await bridge.createLibraryGroup({ name, description: "" });
      await bridge.addDocuments([path], { groupId: folder.id });
      await bridge.setAgentsEnabled(true);
      const connected = await bridge.connectAgent({
        name: "Claude Code",
        client: "claude-code",
        folderIds: [folder.id],
        propose: true,
      });
      return { folderId: folder.id, launch: connected.launch };
    },
    { name: folderName, path: sourcePath },
  );
  await expectReadyDocuments(window, 1);
  return made;
}

async function openMcp(launch: AgentLaunch): Promise<Client> {
  const client = new Client({ name: "test-agent", version: "1.0.0" });
  await client.connect(new StdioClientTransport({ ...launch, stderr: "pipe" }));
  return client;
}

function structured<T>(result: unknown): T {
  const { isError, structuredContent, content } = result as {
    isError?: boolean;
    structuredContent?: unknown;
    content?: { text?: string }[];
  };
  expect(isError ?? false, content?.[0]?.text).toBe(false);
  return structuredContent as T;
}

function refusal(result: unknown): string {
  const { isError, content } = result as { isError?: boolean; content?: { text?: string }[] };
  expect(isError).toBe(true);
  return content?.[0]?.text ?? "";
}

const paragraphsOf = (window: Page) =>
  frontMind(window).getByTestId("mind-editor").locator(":scope > p").filter({ hasText: /\S/ });

for (const language of ["en", "zh-CN"] as const) {
  const copy =
    language === "en"
      ? {
          folder: "Coast",
          title: "Field notes",
          other: "Other notes",
          p1: "Tides rise and fall twice a day along the coast.",
          p2: "The harbour office posts the timetable every Monday.",
          p1Front: "Tides rise and fall twice daily along the coast.",
          p1Hidden: "Tides rise and fall every twelve hours along the coast.",
          p1Closed: "Tides rise and fall along the coast twice daily.",
          typed: " Extra field note.",
          frontLine: /^Changed the paragraph “Tides rise and fall twice daily/,
          hiddenLine: /^Changed the paragraph “Tides rise and fall every twelve/,
          closedLine: /^Changed the paragraph “Tides rise and fall along the/,
          openLabel: "Open",
          undoLabel: "Undo",
          heldCount: "Waiting for you: this rewrites most of your text",
          applyLabel: "Apply",
          discardLabel: "Discard",
        }
      : {
          folder: "海岸",
          title: "田野笔记",
          other: "其他笔记",
          p1: "潮水每天沿着海岸涨落两次。",
          p2: "港务办公室每周一公布潮汐时刻表。",
          p1Front: "潮水每日沿着海岸涨落两次。",
          p1Hidden: "潮水每隔十二小时沿海岸涨落一次。",
          p1Closed: "潮水沿海岸每日涨落两次。",
          typed: "现场补充记录。",
          frontLine: /^修改了“潮水每日沿着海岸涨落两次。”一段$/,
          hiddenLine: /^修改了“潮水每隔十二小时沿海岸涨落一次。”一段$/,
          closedLine: /^修改了“潮水沿海岸每日涨落两次。”一段$/,
          openLabel: "打开",
          undoLabel: "撤销",
          heldCount: "等你确认：这会改写你自己写的大部分内容",
          applyLabel: "应用",
          discardLabel: "放弃",
        };

  // protects=outside-app AI edits to the User's own Note apply at once with Checkpoint, 1-step Undo (including keyboard Cmd+Z on hidden and closed Notes), inline line only in front tab, sidebar Open notice for hidden/closed Notes, and lossless typing guard including concurrent typing (#3839); fails_when=changes wait with Accept all, sidebar notice duplicates front inline line, hidden/closed open misses inline line or Cmd+Z Undo, or typing is lost
  test(`outside-app edit applies at once on front, hidden, and closed User Note with Checkpoint, 1-step Undo, notices, and lossless typing guard (${language})`, async () => {
    test.setTimeout(120_000);
    const { app, window } = await launchApp(dataDir, { home });
    try {
      await acceptPlainTextKeys(window);
      await dismissChatSetup(window);
      await setLanguage(window, language);
      await setWindowSize(app, window, 1440, 900);

      const docPath = join(sources, "Tides.md");
      await writeFile(docPath, "# Tides\n\nSpring tides come twice a month.\n");
      const { folderId, launch } = await connectAgent(window, copy.folder, docPath);

      await newMind(window);
      await nameMind(window, copy.title);
      await enterContent(window);
      await window.keyboard.insertText(copy.p1);
      await window.keyboard.press("Enter");
      await window.keyboard.insertText(copy.p2);
      await expect(paragraphsOf(window)).toHaveText([copy.p1, copy.p2]);
      const mindId = (await frontMind(window).getAttribute("data-mind-id")) ?? "";
      expect(mindId).not.toBe("");
      await window.evaluate(
        async ({ id, folder }) => {
          await (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.moveToFolder({
            mindIds: [id],
            folderId: folder,
          });
        },
        { id: mindId, folder: folderId },
      );

      // Open a second tab so we can hide/close the first Note cleanly.
      await newMind(window);
      await nameMind(window, copy.other);
      const otherId = (await frontMind(window).getAttribute("data-mind-id")) ?? "";
      await pointAndClick(
        window,
        window.locator(`[data-testid="mind-tab"][data-mind-id="${mindId}"]`),
      );
      await expect(frontMind(window)).toHaveAttribute("data-mind-id", mindId);

      const agent = await openMcp(launch);
      try {
        // 1. Front tab: applies immediately, inline line shown, NO sidebar notice, Checkpoint saved (+1), 1-step Undo.
        const checkpointsBefore1 = await window.evaluate(
          async (id) =>
            (
              await (
                globalThis as unknown as { incarnamind: CoreBridge }
              ).incarnamind.listCheckpoints(id)
            ).checkpoints.length,
          mindId,
        );
        const r1 = structured<{ version: string }>(
          await agent.callTool({ name: "read_mind", arguments: { mindId, named: true } }),
        );
        const applied1 = structured<{ status: string; version: string }>(
          await agent.callTool({
            name: "propose_changes",
            arguments: {
              mindId,
              version: r1.version,
              changes: [{ paragraph: "¶1", text: copy.p1Front }],
            },
          }),
        );
        expect(applied1.status).toBe("applied");
        await expect(paragraphsOf(window)).toHaveText([copy.p1Front, copy.p2]);
        const inlineLine = frontMind(window).getByTestId("applied-line");
        await expect(inlineLine.getByTestId("applied-count")).toHaveText(copy.frontLine);
        await expect(inlineLine.getByTestId("applied-undo")).toHaveText(copy.undoLabel);
        await expect(window.getByTestId("proposals-bar")).toHaveCount(0);
        await expect(window.getByTestId(`agent-note-${mindId}`)).toBeHidden();
        const checkpointsAfter1 = await window.evaluate(
          async (id) =>
            (
              await (
                globalThis as unknown as { incarnamind: CoreBridge }
              ).incarnamind.listCheckpoints(id)
            ).checkpoints.length,
          mindId,
        );
        expect(checkpointsAfter1).toBe(checkpointsBefore1 + 1);

        await pointAndClick(window, inlineLine.getByTestId("applied-undo"));
        await expect(paragraphsOf(window)).toHaveText([copy.p1, copy.p2]);
        await expect(inlineLine).toHaveCount(0);

        // 2. Typing guard: real typing during an in-flight outside-app write loses 0 characters, and re-read & reapply works.
        const rBeforeType = structured<{ version: string }>(
          await agent.callTool({ name: "read_mind", arguments: { mindId, named: true } }),
        );
        await pointAndClick(window, paragraphsOf(window).nth(1));
        await window.keyboard.press("End");
        await window.keyboard.insertText(copy.typed);
        await expect(paragraphsOf(window).nth(1)).toHaveText(`${copy.p2}${copy.typed}`);
        const refused = refusal(
          await agent.callTool({
            name: "propose_changes",
            arguments: {
              mindId,
              version: rBeforeType.version,
              changes: [{ paragraph: "¶1", text: copy.p1Front }],
            },
          }),
        );
        expect(refused).toBe(translate(language, "agents.problem.changedByUser"));
        await expect(paragraphsOf(window).nth(1)).toHaveText(`${copy.p2}${copy.typed}`);

        // Concurrent typing while propose_changes is in flight on the same paragraph loses 0 typed characters.
        const concurrentSuffix = language === "en" ? " Live keys." : " live";
        const rConcurrent = structured<{ version: string }>(
          await agent.callTool({ name: "read_mind", arguments: { mindId, named: true } }),
        );
        await pointAndClick(window, paragraphsOf(window).first());
        await window.keyboard.press("End");
        const [, concurrentResult] = await Promise.all([
          window.keyboard.type(concurrentSuffix, { delay: 20 }),
          agent.callTool({
            name: "propose_changes",
            arguments: {
              mindId,
              version: rConcurrent.version,
              changes: [{ paragraph: "¶1", text: copy.p1Front }],
            },
          }),
        ]);
        await expect(paragraphsOf(window).first()).toContainText(concurrentSuffix.trim());
        const concurrentError = (concurrentResult as { isError?: boolean }).isError === true;
        const expectedP1 = concurrentError
          ? `${copy.p1}${concurrentSuffix}`
          : `${copy.p1Front}${concurrentSuffix}`;
        if (concurrentError) {
          expect(refusal(concurrentResult)).toBe(
            translate(language, "agents.problem.changedByUser"),
          );
          await expect(paragraphsOf(window).first()).toHaveText(expectedP1);
        } else {
          expect(structured<{ status: string }>(concurrentResult).status).toBe("applied");
          await expect(paragraphsOf(window).first()).toHaveText(expectedP1);
          await expect(frontMind(window).getByTestId("applied-line")).toHaveCount(0);
        }
        let rAfterType = { version: "", markdown: "" };
        await expect
          .poll(async () => {
            rAfterType = structured<{ version: string; markdown: string }>(
              await agent.callTool({ name: "read_mind", arguments: { mindId, named: true } }),
            );
            return rAfterType.markdown;
          })
          .toContain(expectedP1);
        const reapplied = structured<{ status: string }>(
          await agent.callTool({
            name: "propose_changes",
            arguments: {
              mindId,
              version: rAfterType.version,
              changes: [{ paragraph: "¶1", text: copy.p1 }],
            },
          }),
        );
        expect(reapplied.status).toBe("applied");
        await expect(paragraphsOf(window)).toHaveText([copy.p1, `${copy.p2}${copy.typed}`]);

        // 3. Hidden tab: switch to other tab -> sidebar notice with Open, switching draws inline line + keyboard Cmd+Z Undo.
        await pointAndClick(
          window,
          window.locator(`[data-testid="mind-tab"][data-mind-id="${otherId}"]`),
        );
        await expect(frontMind(window)).toHaveAttribute("data-mind-id", otherId);
        const rHidden = structured<{ version: string }>(
          await agent.callTool({ name: "read_mind", arguments: { mindId, named: true } }),
        );
        const hiddenDone = structured<{ status: string }>(
          await agent.callTool({
            name: "propose_changes",
            arguments: {
              mindId,
              version: rHidden.version,
              changes: [{ paragraph: "¶1", text: copy.p1Hidden }],
            },
          }),
        );
        expect(hiddenDone.status).toBe("applied");
        const sidebarNotice = window.getByTestId(`agent-note-${mindId}`);
        await expect(sidebarNotice).toBeVisible();
        await expect(sidebarNotice.getByTestId("agent-note-open")).toHaveText(copy.openLabel);
        await pointAndClick(window, sidebarNotice.getByTestId("agent-note-open"));
        await expect(frontMind(window)).toHaveAttribute("data-mind-id", mindId);
        await expect(sidebarNotice).toBeHidden();
        await expect(paragraphsOf(window).first()).toHaveText(copy.p1Hidden);
        await expect(
          frontMind(window).getByTestId("applied-line").getByTestId("applied-count"),
        ).toHaveText(copy.hiddenLine);
        await frontMind(window).getByTestId("mind-editor").focus();
        await window.keyboard.press("ControlOrMeta+z");
        await expect(paragraphsOf(window).first()).toHaveText(copy.p1);
        await expect(frontMind(window).getByTestId("applied-line")).toHaveCount(0);

        // 4. Closed Note: close tab -> sidebar notice with Open, reopening draws inline line + keyboard Cmd+Z Undo.
        const tab = window.locator(`[data-testid="mind-tab"][data-mind-id="${mindId}"]`);
        await tab.hover();
        await pointAndClick(window, tab.getByTestId("tab-close"));
        await expect(tab).toHaveCount(0);
        const rClosed = structured<{ version: string }>(
          await agent.callTool({ name: "read_mind", arguments: { mindId, named: true } }),
        );
        const closedDone = structured<{ status: string }>(
          await agent.callTool({
            name: "propose_changes",
            arguments: {
              mindId,
              version: rClosed.version,
              changes: [{ paragraph: "¶1", text: copy.p1Closed }],
            },
          }),
        );
        expect(closedDone.status).toBe("applied");
        await expect(sidebarNotice).toBeVisible();
        await expect(sidebarNotice.getByTestId("agent-note-open")).toHaveText(copy.openLabel);
        await pointAndClick(window, sidebarNotice.getByTestId("agent-note-open"));
        await expect(frontMind(window)).toHaveAttribute("data-mind-id", mindId);
        await expect(sidebarNotice).toBeHidden();
        await expect(paragraphsOf(window).first()).toHaveText(copy.p1Closed);
        await expect(
          frontMind(window).getByTestId("applied-line").getByTestId("applied-count"),
        ).toHaveText(copy.closedLine);
        await frontMind(window).getByTestId("mind-editor").focus();
        await window.keyboard.press("ControlOrMeta+z");
        await expect(paragraphsOf(window).first()).toHaveText(copy.p1);
        await expect(frontMind(window).getByTestId("applied-line")).toHaveCount(0);
      } finally {
        await agent.close();
      }
    } finally {
      await app.close();
    }
  });

  // protects=>50% User-text rewrite holds with Apply · Discard even when closed and reopened, and outside-app edits flip an already-checked User Note from Checked back to unchecked (#3839, #3866); fails_when=reopening falls back to Accept all · Reject all, Apply omits Checkpoint or uncheckedBlocks, or Checked stays stale
  test(`closed-Note >50% held rewrite restores Apply · Discard and updates Checked badge on User Note (${language})`, async () => {
    test.setTimeout(120_000);
    const pdfPath = join(sources, "Tides.pdf");
    await writeFile(
      pdfPath,
      buildPdf([
        {
          lines: [
            "Spring and neap tides",
            "Spring tides happen at new moon and at full moon.",
            "Harbour ferries sail across the strait every morning.",
          ],
        },
      ]),
    );
    const { app, window } = await launchApp(dataDir, { home, fakeChat: true });
    try {
      await acceptPlainTextKeys(window);
      await dismissChatSetup(window);
      await connectLocalChatModel(window);
      await setWindowSize(app, window, 1440, 900);
      await addDocuments(window, [pdfPath]);

      const { folderId, launch } = await window.evaluate(async () => {
        const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
        const folder = await bridge.createLibraryGroup({ name: "Harbour", description: "" });
        const docs = await bridge.listDocuments();
        await bridge.moveToFolder({
          documentIds: docs.map((each) => each.id),
          folderId: folder.id,
        });
        await bridge.setAgentsEnabled(true);
        const connected = await bridge.connectAgent({
          name: "Claude Code",
          client: "claude-code",
          folderIds: [folder.id],
          propose: true,
        });
        return { folderId: folder.id, launch: connected.launch };
      });

      await setLanguage(window, language);
      await newMind(window);
      await nameMind(window, copy.title);
      await enterContent(window);
      const s1 = "Spring tides happen at new and full moon.";
      const s2 = "Harbour ferries sail across the strait every morning.";
      await window.keyboard.insertText(s1);
      await window.keyboard.press("Enter");
      await window.keyboard.insertText(s2);
      const mindId = (await frontMind(window).getAttribute("data-mind-id")) ?? "";
      await window.evaluate(
        async ({ id, folder }) => {
          await (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.moveToFolder({
            mindIds: [id],
            folderId: folder,
          });
        },
        { id: mindId, folder: folderId },
      );

      // Check the Note first so CheckBadge reads Checked / 已核对.
      await checkNote(window);
      const badge = noteCheck(window);
      await expect(badge).toHaveAttribute("data-state", "checked");

      const agent = await openMcp(launch);
      try {
        // Outside-app small edit on checked User Note lands at once and flips Checked -> unchecked.
        const r1 = structured<{ version: string }>(
          await agent.callTool({ name: "read_mind", arguments: { mindId, named: true } }),
        );
        const small = structured<{ status: string }>(
          await agent.callTool({
            name: "propose_changes",
            arguments: {
              mindId,
              version: r1.version,
              changes: [
                { paragraph: "¶1", text: "Spring tides happen at both new and full moon." },
              ],
            },
          }),
        );
        expect(small.status).toBe("applied");
        await expect(badge).toHaveAttribute("data-state", "check");
        await expect(badge).toHaveAttribute(
          "title",
          language === "en" ? /1 sentence not checked yet/ : /1 句未核对/,
        );

        // Re-check so badge is Checked again, then close the Note tab before a >50% rewrite.
        await checkNote(window);
        await expect(badge).toHaveAttribute("data-state", "checked");

        const checkpointsBefore = await window.evaluate(
          async (id) =>
            (
              await (
                globalThis as unknown as { incarnamind: CoreBridge }
              ).incarnamind.listCheckpoints(id)
            ).checkpoints.length,
          mindId,
        );
        const tab = window.locator(`[data-testid="mind-tab"][data-mind-id="${mindId}"]`);
        await tab.hover();
        await pointAndClick(window, tab.getByTestId("tab-close"));
        await expect(tab).toHaveCount(0);

        const r2 = structured<{ version: string }>(
          await agent.callTool({ name: "read_mind", arguments: { mindId, named: true } }),
        );
        const held = structured<{ status: string; why?: string }>(
          await agent.callTool({
            name: "propose_changes",
            arguments: {
              mindId,
              version: r2.version,
              changes: [
                { paragraph: "¶1", text: "Coastal water rises sharply during lunar alignments." },
                { paragraph: "¶2", text: "Vessels depart the pier at dawn each weekday." },
              ],
            },
          }),
        );
        expect(held.status).toBe("waiting");
        expect(held.why).toBe(translate(language, "agents.propose.heldMostText"));

        // Still no extra Checkpoint while held.
        const checkpointsWhileHeld = await window.evaluate(
          async (id) =>
            (
              await (
                globalThis as unknown as { incarnamind: CoreBridge }
              ).incarnamind.listCheckpoints(id)
            ).checkpoints.length,
          mindId,
        );
        expect(checkpointsWhileHeld).toBe(checkpointsBefore);

        // Reopen closed Note from sidebar -> MUST render held Apply · Discard, NEVER ProposalsBar!
        await pointAndClick(
          window,
          window.locator(`[data-testid="mind-row"][data-mind-id="${mindId}"]`).first(),
        );
        await expect(frontMind(window)).toHaveAttribute("data-mind-id", mindId);
        const line = frontMind(window).getByTestId("applied-line");
        await expect(line.getByTestId("applied-count")).toHaveText(copy.heldCount);
        await expect(line.getByTestId("applied-apply")).toHaveText(copy.applyLabel);
        await expect(line.getByTestId("applied-discard")).toHaveText(copy.discardLabel);
        await expect(window.getByTestId("proposals-bar")).toHaveCount(0);

        // Clicking Apply saves a Checkpoint, lands the rewrite, and flips CheckBadge to unchecked!
        await pointAndClick(window, line.getByTestId("applied-apply"));
        await expect(paragraphsOf(window)).toHaveText([
          "Coastal water rises sharply during lunar alignments.",
          "Vessels depart the pier at dawn each weekday.",
        ]);
        await expect(window.getByTestId("proposals-bar")).toHaveCount(0);
        await expect(badge).toHaveAttribute("data-state", "check");
        const checkpointsAfterApply = await window.evaluate(
          async (id) =>
            (
              await (
                globalThis as unknown as { incarnamind: CoreBridge }
              ).incarnamind.listCheckpoints(id)
            ).checkpoints.length,
          mindId,
        );
        expect(checkpointsAfterApply).toBeGreaterThan(checkpointsBefore);
      } finally {
        await agent.close();
      }
    } finally {
      await app.close();
    }
  });
}

// protects=Chinese IME composition (`view.composing === true`) in both the same paragraph and another paragraph refuses an outside-app write with changedByUser, 0 DOM/IME loss, and succeeds cleanly once composition commits (#3839); fails_when=IME is interrupted or wiped, or write slips through while composing in another paragraph
for (const [label, composeParagraph] of [
  ["same paragraph", 0],
  ["another paragraph", 1],
] as const) {
  test(`Chinese IME composing in ${label} refuses write with changedByUser and loses 0 IME text`, async () => {
    test.setTimeout(120_000);
    const { app, window } = await launchApp(dataDir, { home });
    try {
      await acceptPlainTextKeys(window);
      await dismissChatSetup(window);
      await setLanguage(window, "zh-CN");
      await setWindowSize(app, window, 1440, 900);

      const docPath = join(sources, "Tides.md");
      await writeFile(docPath, "# 潮汐\n\n大潮每月出现两次。\n");
      const { folderId, launch } = await connectAgent(window, "海岸", docPath);

      await newMind(window);
      await nameMind(window, "中文输入法测试");
      await enterContent(window);
      const p1 = "潮水每天沿着海岸涨落两次。";
      const p2 = "这里正在用中文输入法输入。";
      await window.keyboard.insertText(p1);
      await window.keyboard.press("Enter");
      await window.keyboard.insertText(p2);
      await expect(paragraphsOf(window)).toHaveText([p1, p2]);
      const mindId = (await frontMind(window).getAttribute("data-mind-id")) ?? "";
      await window.evaluate(
        async ({ id, folder }) => {
          await (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.moveToFolder({
            mindIds: [id],
            folderId: folder,
          });
        },
        { id: mindId, folder: folderId },
      );

      const agent = await openMcp(launch);
      const cdp = await window.context().newCDPSession(window);
      try {
        const read = structured<{ version: string }>(
          await agent.callTool({ name: "read_mind", arguments: { mindId, named: true } }),
        );

        // Place caret at the end of `composeParagraph` and start a real Chromium IME composition.
        await pointAndClick(window, paragraphsOf(window).nth(composeParagraph));
        await window.keyboard.press("End");
        await cdp.send("Input.imeSetComposition", {
          text: "海港",
          selectionStart: 2,
          selectionEnd: 2,
        });
        await expect
          .poll(() =>
            frontMind(window)
              .getByTestId("mind-editor")
              .evaluate((dom) => (dom as unknown as { editor: Editor }).editor.view.composing),
          )
          .toBe(true);

        // Outside-app AI attempts to edit ¶1 while User is composing IME in same or another paragraph.
        const refused = refusal(
          await agent.callTool({
            name: "propose_changes",
            arguments: {
              mindId,
              version: read.version,
              changes: [{ paragraph: "¶1", text: "潮水每日沿着海岸涨落两次。" }],
            },
          }),
        );
        expect(refused).toBe(translate("zh-CN", "agents.problem.changedByUser"));

        // IME composition is still live and unbroken, with 0 text dropped!
        const stillComposing = await frontMind(window)
          .getByTestId("mind-editor")
          .evaluate((dom) => (dom as unknown as { editor: Editor }).editor.view.composing);
        expect(stillComposing).toBe(true);
        await expect(paragraphsOf(window).nth(composeParagraph)).toContainText("海港");

        // Commit IME composition -> re-read and reapply succeeds cleanly with committed Chinese text intact!
        await cdp.send("Input.insertText", { text: "海港" });
        await expect
          .poll(() =>
            frontMind(window)
              .getByTestId("mind-editor")
              .evaluate((dom) => (dom as unknown as { editor: Editor }).editor.view.composing),
          )
          .toBe(false);
        await expect(paragraphsOf(window).nth(composeParagraph)).toContainText("海港");

        let afterIme = { version: "", markdown: "" };
        await expect
          .poll(async () => {
            afterIme = structured<{ version: string; markdown: string }>(
              await agent.callTool({ name: "read_mind", arguments: { mindId, named: true } }),
            );
            return afterIme.markdown;
          })
          .toContain("海港");
        const applied = structured<{ status: string }>(
          await agent.callTool({
            name: "propose_changes",
            arguments: {
              mindId,
              version: afterIme.version,
              changes: [
                {
                  paragraph: "¶1",
                  text:
                    composeParagraph === 0
                      ? "潮水每日沿着海岸涨落两次。海港"
                      : "潮水每日沿着海岸涨落两次。",
                },
              ],
            },
          }),
        );
        expect(applied.status).toBe("applied");
        await expect(paragraphsOf(window).nth(composeParagraph)).toContainText("海港");
        await expect(paragraphsOf(window).first()).toContainText("潮水每日沿着海岸涨落两次。");
      } finally {
        await cdp.detach();
        await agent.close();
      }
    } finally {
      await app.close();
    }
  });
}
