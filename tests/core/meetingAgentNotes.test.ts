import { existsSync } from "node:fs";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { DATABASE_FILE } from "../../src/core";
import { agentSocketPath } from "../../src/core/agents";
import { createFakeCapture } from "../../src/core/meetings/fakeCapture";
import { openDatabase } from "../../src/core/storage";
import { createFakeCloud } from "../../src/core/transcription/fakeCloud";
import { agentsAdapter } from "../helpers/agents";
import { createTempDataFolder, manualClock, startCore } from "../helpers/core";
import { replyingModel, scriptedModels } from "../helpers/models";
import { inProcessTranscriber, NO_TRANSCRIPTION_FILES, until } from "../helpers/transcription";

// protects=using a chosen agent begins only on a press with current access to the Note and Transcript; fails_when=Stop or restart calls a model, a stale grant opens a request, or the handoff contains transcript text
test.each(["en", "zh-CN"] as const)(
  "a saved meeting uses the chosen agent only after a press in %s",
  async (language) => {
    const dataDir = await createTempDataFolder();
    const clock = manualClock();
    const capture = createFakeCapture({ now: () => clock.now().getTime() });
    const sentence = "The violet shipment is due on Friday.";
    const cloud = createFakeCloud({ lines: [sentence], voices: 1 });
    const { transcriber } = inProcessTranscriber({}, undefined, cloud);
    const models = scriptedModels(replyingModel());
    const openLink = vi.fn(async (_url: string) => {});
    const adapters = {
      agents: { ...(await agentsAdapter(dataDir)), openLink },
      createChatModel: models.createChatModel,
      now: clock.now,
      audioCapture: capture,
      transcriber,
      transcriptionModelSource: NO_TRANSCRIPTION_FILES,
      transcriptionKeyFetch: async () => new Response(null, { status: 200 }),
    };
    const core = startCore(dataDir, adapters);
    const folder = await core.createLibraryGroup({ name: "Shipping", description: "" });
    await core.setAgentsEnabled(true);
    const { pairing } = await core.connectAgent({
      name: "Codex",
      client: "codex",
      folderIds: [folder.id],
      propose: language === "zh-CN",
    });
    if (language === "en") {
      await core.saveChatProvider({ kind: "ollama", modelId: "local-model" });
      await core.updateSettings({ device: { meetingNotesAgentId: pairing.id } });
    }
    await core.updateSettings({ user: { language }, device: { meetingNoticeAccepted: true } });
    await core.setTranscriptionKey({ route: "soniox", apiKey: "soniox-test-key-0123456789" });
    await core.updateSettings({ device: { transcriptionRoute: "soniox" } });
    const meeting = await core.createMeeting({ folderId: folder.id });
    const request = {
      mindId: meeting.mindId,
      pairingId: pairing.id,
      ask: { kind: "meeting", meetingId: meeting.id },
    } as const;
    await expect(core.askAgent(request)).rejects.toThrow();
    await core.startMeeting({ meetingId: meeting.id, systemAudio: true });
    await until(core, meeting.id, (state) => state.cloud === "soniox");
    await core.setMeetingMicrophone({ meetingId: meeting.id, paused: true });
    for (let i = 0; i < 12; i++) {
      clock.advance(500);
      capture.push("system", 500);
    }
    await until(core, meeting.id, (state) => state.lines > 0);
    await core.stopMeeting(meeting.id);
    const saved = await until(core, meeting.id, (state) => state.state === "saved");
    const documentId = saved.documentId;
    if (!documentId) throw new Error("Missing saved Transcript");
    await vi.waitFor(async () => {
      expect((await core.listMeetings())[0]?.fill).toMatchObject({
        state: "own-ai",
        agentId: pairing.id,
      });
    });
    expect(openLink).not.toHaveBeenCalled();
    expect(models.specs).toHaveLength(0);
    core.close();
    await vi.waitFor(() => expect(existsSync(agentSocketPath(dataDir))).toBe(false));
    const reopened = startCore(dataDir, adapters);
    expect((await reopened.fillMeetingNotes(meeting.id)).fill?.state).toBe("own-ai");
    expect(openLink).not.toHaveBeenCalled();
    expect(models.specs).toHaveLength(0);
    await expect(reopened.askAgent(request)).resolves.toEqual({ kind: "opened" });
    const prompt = new URL(openLink.mock.calls[0]?.[0] ?? "").searchParams.get("prompt");
    expect(prompt).toContain(meeting.mindId);
    expect(prompt).toContain(documentId);
    expect(prompt).toContain("check_citations");
    expect(prompt?.includes("propose_changes")).toBe(pairing.propose);
    expect(prompt).not.toContain(sentence);
    const privateFolder = await reopened.createLibraryGroup({
      name: "Separate transcript",
      description: "",
      keepInside: true,
    });
    await reopened.updateLibraryGroup(folder.id, {
      name: "Shipping",
      description: "",
      keepInside: true,
    });
    await reopened.updateAgent(pairing.id, { folderIds: [] });
    await expect(reopened.askAgent(request)).rejects.toThrow();
    expect(openLink).toHaveBeenCalledTimes(1);
    reopened.close();
    await vi.waitFor(() => expect(existsSync(agentSocketPath(dataDir))).toBe(false));
    // A legacy meeting whose Note and Transcript were filed behind different walls (#2528).
    const db = openDatabase(join(dataDir, DATABASE_FILE));
    db.run("UPDATE documents SET meeting_mind_id = NULL WHERE id = ?", [documentId]);
    db.close();
    const legacy = startCore(dataDir, adapters);
    await legacy.assignDocumentGroup(documentId, privateFolder.id);
    await legacy.updateAgent(pairing.id, { folderIds: [folder.id] });
    expect((await legacy.listAgentsToAsk(meeting.mindId)).map((p) => p.id)).toContain(pairing.id);
    expect(await legacy.listAgentsToAsk(meeting.mindId, documentId)).toEqual([]);
    await expect(legacy.askAgent(request)).rejects.toThrow();
    expect(openLink).toHaveBeenCalledTimes(1);
    await expect(
      legacy.updateAgent(pairing.id, { folderIds: [folder.id, privateFolder.id] }),
    ).rejects.toThrow();
    await legacy.assignDocumentGroup(documentId, folder.id);
    await expect(legacy.askAgent(request)).resolves.toEqual({ kind: "opened" });
  },
);
