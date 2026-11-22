import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { expect, test } from "@playwright/test";
import type { AgentLaunch, CoreBridge } from "../src/core/api";
import {
  acceptPlainTextKeys,
  catchCopies,
  closeSettings,
  copied,
  coreOf,
  createDataFolder,
  dismissChatSetup,
  firstTranscriptLine,
  launchApp,
  openSettings,
  pointAndClick,
  recordMeeting,
  removeDataFolder,
  setLanguage,
  setWindowSize,
  startRecording,
} from "./app";
import { callTool, connectCanvasAgent } from "./canvases";

/** What the agent reads of the request after the line it was handed (#3419). */
async function requestRead(launch: AgentLaunch): Promise<string> {
  const agent = new Client({ name: "test-agent", version: "1.0.0" });
  await agent.connect(new StdioClientTransport({ ...launch, stderr: "pipe" }));
  try {
    const read = await agent.callTool({ name: "read_request", arguments: {} });
    return (read.structuredContent as { request?: string } | undefined)?.request ?? "";
  } finally {
    await agent.close();
  }
}

// protects=a saved meeting hands a request to the chosen AI only after the User shares its folder and presses the action; fails_when=Stop sends the request, moving the Note leaves the action unavailable, or the request names the wrong transcript
for (const language of ["en", "zh-CN"] as const) {
  test(`after Stop, move the meeting into a shared folder and prepare notes in the chosen AI (${language})`, async () => {
    const dir = await createDataFolder();
    const home = await createDataFolder();
    const { app, window } = await launchApp(dir, { home });
    try {
      await window.emulateMedia({ reducedMotion: "reduce" });
      await setWindowSize(app, window, language === "en" ? 1280 : 900, 850);
      await dismissChatSetup(window);
      expect(await (await coreOf(window)).evaluate((core) => core.listChatProviders())).toEqual([]);
      await acceptPlainTextKeys(window);
      await catchCopies(window);
      const ids = await window.evaluate(async () => {
        const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
        const group = await bridge.createLibraryGroup({ name: "Shipping", description: "" });
        await bridge.setAgentsEnabled(true);
        const { pairing, launch } = await bridge.connectAgent({
          name: "VS Code",
          client: "vscode",
          folderIds: [group.id],
        });
        return { group: group.id, agent: pairing.id, launch };
      });
      const settings = await openSettings(window, "meetings");
      await settings.getByLabel("AI for meeting notes").selectOption(ids.agent);
      await closeSettings(window);
      const bar = await startRecording(window, await recordMeeting(window), { notice: true });
      await (await coreOf(window)).evaluate(async (core) => {
        const meeting = (await core.listMeetings()).find((item) => item.status === "recording");
        const template = (await core.listSkills()).find((skill) => skill.name === "meeting-sales");
        if (!meeting || !template) throw new Error("Missing Meeting or Sales template.");
        await core.setMeetingWriteupTemplate(meeting.id, template.id);
      });
      await firstTranscriptLine(window);
      await window.evaluate(async (lang) => {
        const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
        await bridge.updateSettings({ user: { language: lang } });
      }, language);
      const transcript = window.getByTestId("meeting-note-transcript");
      if (language === "en")
        await pointAndClick(window, bar.getByTestId("meeting-views").locator("label").nth(1));
      await pointAndClick(
        window,
        (language === "en" ? transcript : bar).getByTestId("meeting-stop"),
      );
      const unavailable = window.getByTestId("meeting-agent-unavailable");
      await expect(unavailable).toContainText("VS Code", { timeout: 30000 });
      expect(await copied(window)).toBe("");
      if (process.env.INCARNAMIND_SCREENSHOTS)
        await window.screenshot({
          animations: "disabled",
          path: join(process.env.INCARNAMIND_SCREENSHOTS, `meeting-before-sharing-${language}.png`),
        });
      await unavailable.getByRole("button").click();
      await window.getByTestId("move-to-picker").getByRole("option", { name: "Shipping" }).click();
      await expect(window.getByTestId("move-to-picker")).toBeHidden();
      const action = window.getByTestId("meeting-agent-notes").getByRole("button");
      await expect(action).toHaveText(
        language === "en" ? "Prepare notes with VS Code" : "用 VS Code 整理会议笔记",
      );
      expect(await copied(window)).toBe("");
      if (process.env.INCARNAMIND_SCREENSHOTS)
        await window.screenshot({
          animations: "disabled",
          path: join(process.env.INCARNAMIND_SCREENSHOTS, `meeting-agent-${language}.png`),
        });
      await action.focus();
      await window.keyboard.press("Enter");
      const line =
        language === "en"
          ? "First read the request I left in IncarnaMind"
          : "先读取我留在 IncarnaMind 里的请求";
      await expect.poll(() => copied(window)).toContain(line);
      const meeting = await window.evaluate(async () => {
        const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
        return (await bridge.listMeetings())[0];
      });
      expect(meeting?.fill).toMatchObject({ state: "own-ai", agentId: ids.agent });
      await expect(transcript).toBeHidden();
      const firstRequest = await copied(window);
      expect(firstRequest).not.toContain(meeting?.mindId);
      const request = await requestRead(ids.launch);
      expect(request).toContain(meeting?.mindId);
      expect(request).toContain(meeting?.transcript?.documentId);
      expect(request).toContain("Pricing and terms discussed");
      expect(request).toContain("谈到的价格和条款");
      const workAi = await window.evaluate(async ({ agent, group }) => {
        const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
        await bridge.disconnectAgent(agent);
        const { launch } = await bridge.connectAgent({
          name: "Work AI",
          client: "vscode",
          folderIds: [group],
          propose: true,
        });
        return launch;
      }, ids);
      const reconnected = window
        .getByTestId("meeting-agent-unavailable")
        .getByRole("button", { name: /Work AI/ });
      await expect(reconnected).toBeVisible();
      expect(await copied(window)).toBe(firstRequest);
      await reconnected.click();
      await expect.poll(() => requestRead(workAi)).toContain("¶0+");
    } finally {
      await removeDataFolder(dir);
      await removeDataFolder(home);
    }
  });
  test(`accepting cited notes clears the handoff in Notes and keeps it in the Transcript (${language})`, async () => {
    const dir = await createDataFolder();
    const home = await createDataFolder();
    const { app, window } = await launchApp(dir, { home });
    let agent: Client | undefined;
    try {
      await dismissChatSetup(window);
      await setWindowSize(app, window, language === "en" ? 1280 : 900, 850);
      await catchCopies(window);
      agent = await connectCanvasAgent(window);
      const bridge = await coreOf(window);
      const start = await recordMeeting(window);
      await bridge.evaluate(async (core) => {
        const [pairing] = await core.listAgentsToAsk(null);
        const [meeting] = await core.listMeetings();
        if (!pairing || !meeting) throw new Error("The meeting needs a connected AI");
        const folder = await core.createLibraryGroup({ name: "Shared meetings", description: "" });
        await core.updateAgent(pairing.id, { folderIds: [folder.id] });
        await core.moveToFolder({ mindIds: [meeting.mindId], folderId: folder.id });
        await core.updateSettings({ device: { meetingNotesAgentId: pairing.id } });
      });
      const bar = await startRecording(window, start, { notice: true });
      await firstTranscriptLine(window);
      await setLanguage(window, language);
      await pointAndClick(window, bar.getByTestId("meeting-stop"));
      const action = window.getByTestId("meeting-agent-notes").getByRole("button");
      await expect(action).toBeVisible();
      await action.click();
      await callTool(agent, "read_request", {});
      const [meeting] = await bridge.evaluate((core) => core.listMeetings());
      if (!meeting?.transcript?.documentId) throw new Error("The meeting needs a saved Transcript");
      const read = await callTool<{ passages: { passageId: string; text: string }[] }>(
        agent,
        "read_passages",
        { documentId: meeting.transcript.documentId },
      );
      const passage = read.passages[0];
      if (!passage) throw new Error("The saved Transcript needs a Passage");
      const quote = passage.text.split("\n")[0] ?? "";
      const cited = await callTool<{ citations: { cite: string }[] }>(agent, "cite", {
        citations: [{ passageId: passage.passageId, quote }],
      });
      const cite = cited.citations[0]?.cite;
      expect(cite).toBeTruthy();
      const { version } = await callTool<{ version: string }>(agent, "read_mind", {
        mindId: meeting.mindId,
        named: true,
      });
      await callTool(agent, "propose_changes", {
        mindId: meeting.mindId,
        version,
        changes: [{ paragraph: "¶0+", text: `${quote} ${cite}` }],
      });
      await expect(action).toBeVisible();
      await pointAndClick(window, window.getByTestId("proposals-accept-all"));
      await expect(window.getByTestId("mind-editor").getByTestId("citation")).toBeVisible();
      await expect(action).toBeHidden();
      if (process.env.INCARNAMIND_SCREENSHOTS)
        await window.screenshot({
          animations: "disabled",
          path: join(process.env.INCARNAMIND_SCREENSHOTS, `meeting-accepted-${language}.png`),
        });
      await pointAndClick(window, window.getByTestId("meeting-view-chip"));
      await pointAndClick(
        window,
        window.getByTestId("meeting-view-menu").getByTestId("meeting-view-transcript"),
      );
      const transcript = window.getByTestId("meeting-note-transcript");
      await expect(transcript.getByRole("button", { name: /Claude Code/ })).toBeVisible();
    } finally {
      await agent?.close();
      await removeDataFolder(dir);
      await removeDataFolder(home);
    }
  });
}

// protects=an unshared meeting gives the User a way to restore the selected AI's access
// fails_when=the summary offers an impossible retry or keeps blocking it after sharing the meeting
for (const transcriptFails of [false, true]) {
  test(
    transcriptFails
      ? "a failed transcript offers transcription recovery before summary access"
      : "a failed summary can be retried once its original AI can read the meeting",
    async () => {
      const dir = await createDataFolder();
      const home = await createDataFolder();
      const { window } = await launchApp(dir, {
        home,
        ...(transcriptFails && { transcriber: { failToLoad: "engine unavailable" } }),
      });
      try {
        await dismissChatSetup(window);
        await acceptPlainTextKeys(window);
        const bridge = await coreOf(window);
        const agent = await bridge.evaluate(async (core) => {
          await core.setAgentsEnabled(true);
          const group = await core.createLibraryGroup({ name: "Shared meetings", description: "" });
          const { pairing } = await core.connectAgent({
            client: "claude-code",
            name: "My Claude",
            folderIds: [group.id],
          });
          return pairing.id;
        });
        const settings = await openSettings(window, "meetings");
        await settings.getByLabel("AI for meeting notes").selectOption(agent);
        await settings.getByTestId("meeting-summary-route").selectOption(agent);
        await closeSettings(window);
        const bar = await startRecording(window, await recordMeeting(window), { notice: true });
        if (transcriptFails)
          await expect(window.getByTestId("meeting-transcript-line")).toContainText(
            "Transcription stopped",
            { timeout: 30_000 },
          );
        else await firstTranscriptLine(window);
        await pointAndClick(window, bar.getByTestId("meeting-stop"));
        const problem = window.getByTestId("meeting-summary-problem");
        if (transcriptFails) {
          await expect(problem).toContainText("A saved transcript is needed");
          await expect(problem.getByRole("button", { name: "Retry transcription" })).toBeEnabled();
          await expect(problem.getByRole("button", { name: "Settings › AI" })).toHaveCount(0);
          return;
        }
        await expect(problem).toContainText("access to the meeting note and transcript");
        await expect(problem.getByTestId("meeting-summary-retry")).toHaveCount(0);
        await problem.getByRole("button", { name: "Settings › AI" }).click();
        await expect(settings).toHaveAttribute("data-page", "ai");
        await expect(settings.getByTestId("agents-settings")).toBeInViewport();
        await closeSettings(window);
        await window.getByTestId("meeting-agent-unavailable").getByRole("button").click();
        await window
          .getByTestId("move-to-picker")
          .getByRole("option", { name: "Shared meetings" })
          .click();
        await expect(problem.getByTestId("meeting-summary-retry")).toBeEnabled();
        await bridge.evaluate((core) =>
          core.updateSettings({ device: { meetingSummaryRoute: null } }),
        );
        await expect(problem.getByTestId("meeting-summary-retry")).toHaveCount(0);
        await expect(problem).toContainText("Choose My Claude");
        await problem.getByRole("button", { name: "Settings", exact: true }).click();
        await expect(settings).toHaveAttribute("data-page", "meetings");
        await settings.getByTestId("meeting-summary-route").selectOption(agent);
        await closeSettings(window);
        await expect(problem.getByTestId("meeting-summary-retry")).toBeEnabled();
      } finally {
        await removeDataFolder(dir);
        await removeDataFolder(home);
      }
    },
  );
}
