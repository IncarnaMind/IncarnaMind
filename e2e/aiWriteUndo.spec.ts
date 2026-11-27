import { chmod, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { expect, type Page, test } from "@playwright/test";
import type { Editor } from "@tiptap/core";
import type { AgentLaunch, CitationAttributes, CoreBridge } from "../src/core/api";
import { SHOW_AGENT_CONNECTION } from "../src/shared/agentConnection";
import { translate } from "../src/shared/i18n";
import {
  acceptPlainTextKeys,
  addDocuments,
  useLocalChatModel as chooseScriptedModel,
  clickEditItem,
  createDataFolder,
  dismissChatSetup,
  expectReadyDocuments,
  frontMind,
  launchApp,
  newMind,
  pointAndClick,
  pointAt,
  removeDataFolder,
  setLanguage,
  setWindowSize,
  sidebarFolder,
  writeNote,
} from "./app";

/*
 * Cmd+Z and History on AI writes into a Note (#3839):
 * 1. Caret left in the empty Note input after sending: Cmd+Z and Cmd+Shift+Z act on the Note;
 *    words typed in the input keep the input's own undo; an open IME composition is never disturbed.
 * 2. Hidden tab when a turn ends: the write lands on that tab's kept undo stack as one step,
 *    newest first, never lost when the User undoes something elsewhere.
 * 3. A Note the AI made (both via Note input and via outside MCP): undo runs newest first.
 * 4. History saves a pre-AI version ("before AI edits" / "接受修订前") for Note-input writes,
 *    Accept change, Change to, and Fix the sentence alike.
 * 5. Words typed just before or just after an AI write never join its undo step.
 */

let dataDir: string;
let sources: string;
let home: string;
let bin: string;

test.beforeEach(async () => {
  dataDir = await createDataFolder();
  sources = await realpath(await createDataFolder());
  home = await realpath(await createDataFolder());
  bin = await realpath(await createDataFolder());
  await writeFile(
    join(bin, "claude"),
    `#!/bin/sh\nexec "${process.execPath}" "${join(__dirname, "fixtures", "fakeClaudeCode.mjs")}" "$@"\n`,
  );
  await chmod(join(bin, "claude"), 0o755);
});

test.afterEach(async () => {
  for (const folder of [dataDir, sources, home, bin]) await removeDataFolder(folder);
});

const nextRun = (mode: string) => writeFile(join(bin, "mode"), mode);
const setStep = (step: number) => writeFile(join(bin, "mode.step"), String(step));
const undoKey = (window: Page) => window.keyboard.press("ControlOrMeta+z");
const redoKey = (window: Page) => window.keyboard.press("ControlOrMeta+Shift+z");

async function connectClaude(
  window: Page,
): Promise<{ folderId: string; pairingId: string; launch: AgentLaunch }> {
  const report = join(sources, "Annual report 2025.md");
  await writeFile(
    report,
    "# Annual report 2025\n\nIn 2025 the harbour handled 1,240 ship calls.\n",
  );
  const made = await window.evaluate(async (path) => {
    const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    const folder = await bridge.createLibraryGroup({ name: "Kestrel Bay", description: "" });
    await bridge.addDocuments([path], { groupId: folder.id });
    await bridge.setAgentsEnabled(true);
    const claude = await bridge.connectAgent({
      name: "Claude Code",
      client: "claude-code",
      folderIds: [folder.id],
      propose: true,
    });
    return { folderId: folder.id, pairingId: claude.pairing.id, launch: claude.launch };
  }, report);
  await expectReadyDocuments(window, 1);
  return made;
}

async function openMind(window: Page, mindId: string) {
  const folderRow = sidebarFolder(window, "Kestrel Bay").getByTestId("folder-row");
  if ((await folderRow.getAttribute("aria-expanded")) !== "true") {
    await pointAndClick(window, folderRow);
  }
  await pointAndClick(
    window,
    window.locator(`[data-testid="mind-row"][data-mind-id="${mindId}"]`).first(),
  );
  await expect(frontMind(window)).toHaveAttribute("data-mind-id", mindId);
}

const noteAskBox = (window: Page) =>
  window.locator('[data-testid="tab-group"][data-focused] [data-testid="note-ask"]');

async function sendNoteAsk(window: Page, text: string) {
  const box = noteAskBox(window);
  const input = box.getByTestId("note-ask-input");
  await pointAndClick(window, input);
  await window.keyboard.type(text);
  await window.keyboard.press("Enter");
  return { box, input };
}

async function acceptCheckpointsOf(window: Page, mindId: string): Promise<number> {
  return window.evaluate(async (id) => {
    const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    const { checkpoints } = await bridge.listCheckpoints(id);
    return checkpoints.filter((each) => each.reason === "accept").length;
  }, mindId);
}

async function openHistoryFor(window: Page, mindId: string) {
  const row = window.locator(`[data-testid="mind-row"][data-mind-id="${mindId}"]`).first();
  await pointAt(window, row);
  await pointAndClick(window, row.getByTestId("mind-menu"));
  await pointAndClick(window, row.getByTestId("mind-actions").getByTestId("mind.history"));
  const history = window.getByTestId("history");
  await expect(history).toBeVisible();
  return history;
}

test.describe("Note-input and AI-owned Note Cmd+Z (#3839)", () => {
  test.skip(!SHOW_AGENT_CONNECTION, "Your AI is hidden while SHOW_AGENT_CONNECTION is false.");
  test.skip(
    process.platform === "win32",
    "The stand-in for Claude Code starts from a shell script.",
  );

  for (const language of ["en", "zh-CN"] as const) {
    test(`empty Note input sends Cmd+Z and Cmd+Shift+Z to the Note, keeps input undo & IME safe, isolates adjacent typing, and saves History (${language})`, async () => {
      test.setTimeout(120_000);
      const copy =
        language === "en"
          ? {
              title: "Harbour notes",
              seed: "The harbour handled 1,240 ship calls in 2025.",
              before: "Typed just before AI.",
              ask: "Add a summary",
              aiText: "Ferry interviews",
              after: "Typed just after AI.",
              promptDraft: "draft prompt words",
            }
          : {
              title: "港口笔记",
              seed: "2025 年港口接待了 1,240 次靠港。",
              before: "AI 写入前刚打的一行。",
              ask: "加一段总结",
              aiText: "渡轮访谈",
              after: "AI 写入后刚打的一行。",
              promptDraft: "草稿提示词",
            };

      const { app, window } = await launchApp(dataDir, {
        home,
        ownAi: join(bin, "claude"),
        extraEnv: { INCARNAMIND_TEST_OWN_AI_MODE_FILE: join(bin, "mode") },
      });
      await acceptPlainTextKeys(window);
      try {
        await dismissChatSetup(window);
        await setLanguage(window, language);
        await setWindowSize(app, window, 1440, 900);
        const { folderId } = await connectClaude(window);
        const mindId = await writeNote(window, copy.title, [{ text: copy.seed }], { folderId });
        await openMind(window, mindId);

        // Type just before sending (no delay) so Yjs captureTimeout would merge if unguarded.
        await pointAndClick(window, frontMind(window).locator("p").last());
        await window.keyboard.press("End");
        await window.keyboard.press("Enter");
        await window.keyboard.type(copy.before);
        await expect(frontMind(window)).toContainText(copy.before);

        await nextRun("summary");
        const { box, input } = await sendNoteAsk(window, copy.ask);
        await expect(box.getByTestId("note-ask-pill")).toHaveAttribute("data-state", "landed", {
          timeout: 30_000,
        });
        await expect(frontMind(window)).toContainText(copy.aiText);

        // History saved a version from before the AI write.
        await expect.poll(() => acceptCheckpointsOf(window, mindId)).toBe(1);

        // Caret is still in the empty Note input: Cmd+Z / Cmd+Shift+Z and Edit menu act on the Note.
        await expect(input).toBeFocused();
        await expect(input).toHaveValue("");
        await undoKey(window);
        await expect(frontMind(window)).not.toContainText(copy.aiText);
        await expect(frontMind(window)).toContainText(copy.before);

        await redoKey(window);
        await expect(frontMind(window)).toContainText(copy.aiText);

        await clickEditItem(app, "edit.undo");
        await expect(frontMind(window)).not.toContainText(copy.aiText);
        await clickEditItem(app, "edit.redo");
        await expect(frontMind(window)).toContainText(copy.aiText);

        // Words typed in the Note input keep the input's own undo; Note stays untouched.
        await window.keyboard.type(copy.promptDraft);
        await expect(input).toHaveValue(copy.promptDraft);
        await undoKey(window);
        await expect(frontMind(window)).toContainText(copy.aiText);
        if ((await input.inputValue()) === copy.promptDraft) await clickEditItem(app, "edit.undo");
        await expect
          .poll(async () => {
            const now = await input.inputValue();
            return now !== copy.promptDraft && copy.promptDraft.startsWith(now);
          })
          .toBe(true);
        await expect(frontMind(window)).toContainText(copy.aiText);
        // Clear any remaining characters (CJK inserts undo one character at a time in Chromium).
        for (let step = 0; step < copy.promptDraft.length; step++) {
          const beforeClear = await input.inputValue();
          if (beforeClear === "") break;
          await clickEditItem(app, "edit.undo");
          await expect.poll(() => input.inputValue()).not.toBe(beforeClear);
        }
        await expect(input).toHaveValue("");
        await expect(frontMind(window)).toContainText(copy.aiText);

        // Redo right after undoing the input back to empty belongs to the input even when the Note
        // has an undone step ready to redo; once a further undo acts on the Note, Redo returns to
        // the Note (#3839).
        await undoKey(window);
        await expect(frontMind(window)).not.toContainText(copy.aiText);
        await window.keyboard.type(copy.promptDraft);
        await expect(input).toHaveValue(copy.promptDraft);
        for (let step = 0; step < copy.promptDraft.length; step++) {
          const beforeClear = await input.inputValue();
          if (beforeClear === "") break;
          await clickEditItem(app, "edit.undo");
          await expect.poll(() => input.inputValue()).not.toBe(beforeClear);
        }
        await expect(input).toHaveValue("");
        await redoKey(window);
        if ((await input.inputValue()) === "") await clickEditItem(app, "edit.redo");
        await expect.poll(() => input.inputValue()).not.toBe("");
        await expect(frontMind(window)).not.toContainText(copy.aiText);
        await undoKey(window);
        if ((await input.inputValue()) !== "") await clickEditItem(app, "edit.undo");
        await expect(input).toHaveValue("");
        await undoKey(window);
        await expect(frontMind(window)).not.toContainText(copy.before);
        await redoKey(window);
        await expect(frontMind(window)).toContainText(copy.before);
        await expect(input).toHaveValue("");
        await redoKey(window);
        await expect(frontMind(window)).toContainText(copy.aiText);

        // Open IME composition in the empty input is never interrupted and never undoes the Note.
        await input.evaluate((el) => {
          el.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true, data: "" }));
        });
        await undoKey(window);
        await expect(frontMind(window)).toContainText(copy.aiText);
        await input.evaluate((el) => {
          el.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "" }));
        });

        // Type just after the AI write landed: never joins the AI step.
        await pointAndClick(window, frontMind(window).locator("p").last());
        await window.keyboard.press("End");
        await window.keyboard.press("Enter");
        await window.keyboard.type(copy.after);
        await expect(frontMind(window)).toContainText(copy.after);

        // Three Cmd+Z presses undo newest first: after-typing -> AI write -> before-typing.
        await undoKey(window);
        await expect(frontMind(window)).not.toContainText(copy.after);
        await expect(frontMind(window)).toContainText(copy.aiText);

        await undoKey(window);
        await expect(frontMind(window)).not.toContainText(copy.aiText);
        await expect(frontMind(window)).toContainText(copy.before);

        await undoKey(window);
        await expect(frontMind(window)).not.toContainText(copy.before);
        await expect(frontMind(window)).toContainText(copy.seed);

        // Redo restores all three in order.
        await redoKey(window);
        await expect(frontMind(window)).toContainText(copy.before);
        await redoKey(window);
        await expect(frontMind(window)).toContainText(copy.aiText);
        await redoKey(window);
        await expect(frontMind(window)).toContainText(copy.after);

        // History UI shows the pre-AI version in the active language.
        const history = await openHistoryFor(window, mindId);
        await expect(history.getByTestId("history-picker-left")).toContainText(
          translate(language, "history.reason.accept"),
        );
      } finally {
        await app.close();
      }
    });
  }

  test("a write that ends while its tab is hidden lands on that tab's kept undo stack, newest first, unaffected by unrelated undo elsewhere", async () => {
    test.setTimeout(120_000);
    const { app, window } = await launchApp(dataDir, {
      home,
      ownAi: join(bin, "claude"),
      extraEnv: { INCARNAMIND_TEST_OWN_AI_MODE_FILE: join(bin, "mode") },
    });
    await acceptPlainTextKeys(window);
    try {
      await dismissChatSetup(window);
      await setWindowSize(app, window, 1440, 900);
      const { folderId } = await connectClaude(window);
      const noteA = await writeNote(window, "Hidden target", [{ text: "Alpha seed." }], {
        folderId,
      });
      const noteB = await writeNote(window, "Other tab", [{ text: "Beta seed." }], { folderId });

      await openMind(window, noteA);
      await pointAndClick(window, frontMind(window).locator("p").last());
      await window.keyboard.press("End");
      await window.keyboard.press("Enter");
      await window.keyboard.type("User typed before switching.");
      await expect(frontMind(window)).toContainText("User typed before switching.");

      await setStep(0);
      await nextRun("summary-gated");
      const { box } = await sendNoteAsk(window, "Add a summary");
      await expect(box.getByTestId("note-ask-pill")).toHaveAttribute("data-state", "working", {
        timeout: 20_000,
      });

      // Switch to Note B while Note A's request is still running.
      await openMind(window, noteB);
      // Let Note A's AI finish while Note A's tab is hidden.
      await setStep(1);
      await expect
        .poll(
          async () =>
            window.evaluate(async (id) => {
              const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
              const turns = await bridge.noteTurnsForMind(id);
              return turns.length > 0 && turns[turns.length - 1]?.reply !== "";
            }, noteA),
          { timeout: 30_000 },
        )
        .toBe(true);
      await expect.poll(() => acceptCheckpointsOf(window, noteA)).toBe(1);

      // Do an unrelated edit & undo in Note B while Note A is hidden.
      await pointAndClick(window, frontMind(window).locator("p").last());
      await window.keyboard.press("End");
      await window.keyboard.type(" Temporary beta edit.");
      await expect(frontMind(window)).toContainText("Temporary beta edit.");
      await undoKey(window);
      await expect(frontMind(window)).not.toContainText("Temporary beta edit.");

      // Return to Note A: AI write is there; Cmd+Z undoes AI first, then User's older typing.
      await openMind(window, noteA);
      await expect(frontMind(window)).toContainText("Ferry interviews");
      await pointAndClick(window, frontMind(window).locator("p").first());

      await undoKey(window);
      await expect(frontMind(window)).not.toContainText("Ferry interviews");
      await expect(frontMind(window)).toContainText("User typed before switching.");

      await undoKey(window);
      await expect(frontMind(window)).not.toContainText("User typed before switching.");
      await expect(frontMind(window)).toContainText("Alpha seed.");

      // Redo brings back User's typing then AI write.
      await redoKey(window);
      await expect(frontMind(window)).toContainText("User typed before switching.");
      await redoKey(window);
      await expect(frontMind(window)).toContainText("Ferry interviews");
    } finally {
      await app.close();
    }
  });

  test("an AI-created Note undoes newest first after both Note-input writes and outside MCP writes", async () => {
    test.setTimeout(120_000);
    const { app, window } = await launchApp(dataDir, {
      home,
      ownAi: join(bin, "claude"),
      extraEnv: { INCARNAMIND_TEST_OWN_AI_MODE_FILE: join(bin, "mode") },
    });
    await acceptPlainTextKeys(window);
    try {
      await dismissChatSetup(window);
      await setWindowSize(app, window, 1440, 900);
      const { folderId, launch } = await connectClaude(window);
      const seedNote = await writeNote(window, "Starter", [{ text: "Start line." }], { folderId });
      await openMind(window, seedNote);

      // Part A: AI creates a Note via Note input, User types in it, then AI edits via Note input.
      await nextRun("write");
      const { box: writeBox } = await sendNoteAsk(window, "Write this up as a new note");
      await expect(writeBox.getByTestId("note-ask-open")).toBeVisible({ timeout: 30_000 });
      await pointAndClick(window, writeBox.getByTestId("note-ask-open"));
      await expect(frontMind(window)).toContainText(
        "The harbour handled 1,240 ship calls in 2025.",
      );
      const ownMindId = await frontMind(window).getAttribute("data-mind-id");
      if (!ownMindId) throw new Error("Missing own mind id.");

      await pointAndClick(window, frontMind(window).locator("p").last());
      await window.keyboard.press("End");
      await window.keyboard.press("Enter");
      await window.keyboard.type("User typed in AI note.");
      await expect(frontMind(window)).toContainText("User typed in AI note.");

      await nextRun("summary");
      const { box: ownBox, input: ownInput } = await sendNoteAsk(window, "Add a summary");
      await expect(ownBox.getByTestId("note-ask-pill")).toHaveAttribute("data-state", "landed", {
        timeout: 30_000,
      });
      await expect(frontMind(window)).toContainText("Ferry interviews");
      await expect.poll(() => acceptCheckpointsOf(window, ownMindId)).toBeGreaterThanOrEqual(1);

      // Even from the empty Note input: 1st Cmd+Z undoes AI summary, 2nd undoes User's typing.
      await expect(ownInput).toBeFocused();
      await undoKey(window);
      await expect(frontMind(window)).not.toContainText("Ferry interviews");
      await expect(frontMind(window)).toContainText("User typed in AI note.");

      await undoKey(window);
      await expect(frontMind(window)).not.toContainText("User typed in AI note.");
      await expect(frontMind(window)).toContainText(
        "The harbour handled 1,240 ship calls in 2025.",
      );

      await redoKey(window);
      await expect(frontMind(window)).toContainText("User typed in AI note.");
      await redoKey(window);
      await expect(frontMind(window)).toContainText("Ferry interviews");

      // Part B: Outside MCP client edits the same AI-created Note after User types another line.
      const agent = new Client({ name: "test-agent", version: "1.0.0" });
      await agent.connect(new StdioClientTransport({ ...launch, stderr: "pipe" }));
      try {
        await pointAndClick(window, frontMind(window).locator("p").last());
        await window.keyboard.press("End");
        await window.keyboard.press("Enter");
        await window.keyboard.type("User typed before MCP edit.");
        await expect(frontMind(window)).toContainText("User typed before MCP edit.");

        const read = (
          (await agent.callTool({
            name: "read_mind",
            arguments: { mindId: ownMindId, named: true },
          })) as { structuredContent?: { version: string; markdown: string } }
        ).structuredContent;
        const names = [...(read?.markdown ?? "").matchAll(/^¶(\d+)/gm)].map((m) => Number(m[1]));
        await agent.callTool({
          name: "propose_changes",
          arguments: {
            mindId: ownMindId,
            version: read?.version,
            changes: [{ paragraph: `¶${Math.max(...names)}+`, text: "Outside MCP appended line." }],
          },
        });
        await expect(frontMind(window)).toContainText("Outside MCP appended line.");

        await pointAndClick(window, frontMind(window).locator("p").first());
        // 1st Cmd+Z undoes outside MCP edit FIRST, 2nd undoes User's older typing.
        await undoKey(window);
        await expect(frontMind(window)).not.toContainText("Outside MCP appended line.");
        await expect(frontMind(window)).toContainText("User typed before MCP edit.");

        await undoKey(window);
        await expect(frontMind(window)).not.toContainText("User typed before MCP edit.");

        await redoKey(window);
        await expect(frontMind(window)).toContainText("User typed before MCP edit.");
        await redoKey(window);
        await expect(frontMind(window)).toContainText("Outside MCP appended line.");
      } finally {
        await agent.close();
      }
    } finally {
      await app.close();
    }
  });
});

test("Check reply fixes (Fix the sentence, Accept change, Change to) save History and isolate adjacent typing in EN and ZH-CN", async () => {
  test.setTimeout(120_000);
  const quote = "The Eastgate terminal opened in September 2025, six months later than planned.";
  const sentence = "The Eastgate terminal opened on schedule in 2025.";
  const leaseQuote = "The Tenant pays a break fee of $57,000.";
  const leaseSentence = "The Tenant pays a break fee of $99,000.";
  await writeFile(join(sources, "Annual review.txt"), `${quote}\n`);
  await writeFile(join(sources, "Lease.txt"), `${leaseQuote}\n`);

  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  try {
    await dismissChatSetup(window);
    await chooseScriptedModel(window);
    await setWindowSize(app, window, 1440, 900);
    await addDocuments(window, [join(sources, "Annual review.txt"), join(sources, "Lease.txt")]);
    const docs = await window.evaluate(() =>
      (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.listDocuments(),
    );
    const reviewDoc = docs.find((d) => d.name.includes("Annual review"));
    const leaseDoc = docs.find((d) => d.name.includes("Lease"));
    if (!reviewDoc || !leaseDoc) throw new Error("Missing seeded documents.");

    const reviewEvidence: CitationAttributes = {
      passageId: "passage-review",
      documentId: reviewDoc.id,
      documentName: reviewDoc.name,
      contentHash: reviewDoc.contentHash,
      pageFrom: null,
      pageTo: null,
      location: null,
      quote,
      check: "found",
      checkReason: null,
    };
    const leaseEvidence: CitationAttributes = {
      passageId: "passage-lease",
      documentId: leaseDoc.id,
      documentName: leaseDoc.name,
      contentHash: leaseDoc.contentHash,
      pageFrom: null,
      pageTo: null,
      location: null,
      quote: leaseQuote,
      check: "found",
      checkReason: null,
    };

    // 1. Fix the sentence (reference baseline)
    await newMind(window);
    const fixMindId = await frontMind(window).getAttribute("data-mind-id");
    if (!fixMindId) throw new Error("Missing fix mind id.");
    await window.getByTestId("mind-editor").evaluate(
      (dom, content) => {
        (dom as unknown as { editor: Editor }).editor.commands.insertContentAt(0, content);
      },
      [
        { type: "paragraph", content: [{ type: "text", text: "Intro." }] },
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              text: sentence,
              marks: [
                {
                  type: "claimCheck",
                  attrs: {
                    id: "fix-1",
                    request: "req-fix-1",
                    action: "check-against-documents",
                    state: "contradicted",
                    providerId: "anthropic",
                    modelId: "claude-haiku-5-5",
                    text: sentence,
                    reason: null,
                    detail: null,
                    evidence: reviewEvidence,
                    says: "The review says it opened six months late.",
                    unsupported: null,
                    calculation: null,
                    citedCaseUnchecked: false,
                    citedCaseFound: false,
                    scope: { folderId: null, widened: false },
                    versions: [],
                    excluded: [],
                    checkedAt: new Date(Date.now() + 60_000).toISOString(),
                  },
                },
              ],
            },
          ],
        },
      ],
    );
    await pointAndClick(window, window.getByTestId("claim-mark").first());
    await pointAndClick(window, window.getByTestId("claim-card").getByTestId("claim-fix"));
    await expect(frontMind(window)).toContainText(quote, { timeout: 30_000 });
    await expect.poll(() => acceptCheckpointsOf(window, fixMindId)).toBe(1);

    // 2. Accept change (own-AI check reply) — with typing just before & just after + History
    await newMind(window);
    const acceptMindId = await frontMind(window).getAttribute("data-mind-id");
    if (!acceptMindId) throw new Error("Missing accept mind id.");
    await window.getByTestId("mind-editor").evaluate(
      (dom, content) => {
        (dom as unknown as { editor: Editor }).editor.commands.insertContentAt(0, content);
      },
      [
        { type: "paragraph", content: [{ type: "text", text: "Lease notes." }] },
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              text: leaseSentence,
              marks: [
                {
                  type: "claimCheck",
                  attrs: {
                    id: "own-1",
                    request: "req-own-1",
                    action: "check-against-documents",
                    state: "contradicted",
                    providerId: "outside-agent",
                    modelId: "Claude Code",
                    text: leaseSentence,
                    reason: null,
                    detail: null,
                    evidence: leaseEvidence,
                    says: "The lease states $57,000.",
                    change: { replace: "$99,000", with: "$57,000" },
                    unsupported: null,
                    calculation: null,
                    citedCaseUnchecked: false,
                    citedCaseFound: false,
                    scope: { folderId: null, widened: false },
                    versions: [],
                    excluded: [],
                    checkedAt: new Date(Date.now() + 60_000).toISOString(),
                  },
                },
              ],
            },
          ],
        },
      ],
    );
    // Type just before Accept change (no delay)
    await pointAndClick(window, frontMind(window).locator("p").first());
    await window.keyboard.press("End");
    await window.keyboard.type(" Before.");
    await pointAndClick(window, window.getByTestId("claim-mark").first());
    await pointAndClick(
      window,
      window.getByTestId("claim-card").getByTestId("claim-accept-change"),
    );
    await expect(frontMind(window)).toContainText("$57,000");
    await expect.poll(() => acceptCheckpointsOf(window, acceptMindId)).toBe(1);
    // Type just after Accept change (no delay)
    await pointAndClick(window, frontMind(window).locator("p").first());
    await window.keyboard.press("End");
    await window.keyboard.type(" After.");

    await undoKey(window);
    await expect(frontMind(window)).not.toContainText("After.");
    await expect(frontMind(window)).toContainText("$57,000");
    await undoKey(window);
    await expect(frontMind(window)).toContainText("$99,000");
    await expect(frontMind(window)).toContainText("Before.");
    await undoKey(window);
    await expect(frontMind(window)).not.toContainText("Before.");
    await redoKey(window);
    await redoKey(window);
    await expect(frontMind(window)).toContainText("$57,000");

    // 3. Change to (no built-in model) — History in ZH-CN too
    await setLanguage(window, "zh-CN");
    await window.evaluate(async () => {
      const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
      for (const provider of await bridge.listChatProviders()) {
        await bridge.deleteChatProvider(provider.id);
      }
    });
    await newMind(window);
    const corrMindId = await frontMind(window).getAttribute("data-mind-id");
    if (!corrMindId) throw new Error("Missing correction mind id.");
    await window.getByTestId("mind-editor").evaluate(
      (dom, content) => {
        (dom as unknown as { editor: Editor }).editor.commands.insertContentAt(0, content);
      },
      [
        { type: "paragraph", content: [{ type: "text", text: "租约记录。" }] },
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              text: leaseSentence,
              marks: [
                {
                  type: "claimCheck",
                  attrs: {
                    id: "corr-1",
                    request: "req-corr-1",
                    action: "check-against-documents",
                    state: "contradicted",
                    providerId: "anthropic",
                    modelId: "claude-haiku-5-5",
                    text: leaseSentence,
                    reason: null,
                    detail: null,
                    evidence: leaseEvidence,
                    correction: {
                      from: "$99,000",
                      choices: [{ wording: "$57,000", evidence: leaseEvidence }],
                    },
                    says: null,
                    unsupported: null,
                    calculation: null,
                    citedCaseUnchecked: false,
                    citedCaseFound: false,
                    scope: { folderId: null, widened: false },
                    versions: [],
                    excluded: [],
                    checkedAt: new Date(Date.now() + 60_000).toISOString(),
                  },
                },
              ],
            },
          ],
        },
      ],
    );
    await pointAndClick(window, window.getByTestId("claim-mark").first());
    await pointAndClick(window, window.getByTestId("claim-card").getByTestId("claim-correct"));
    await expect(frontMind(window)).toContainText("$57,000");
    await expect.poll(() => acceptCheckpointsOf(window, corrMindId)).toBe(1);
    const history = await openHistoryFor(window, corrMindId);
    await expect(history.getByTestId("history-picker-left")).toContainText(
      translate("zh-CN", "history.reason.accept"),
    );
  } finally {
    await app.close();
  }
});
