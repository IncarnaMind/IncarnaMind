import { MockLanguageModelV4 } from "ai/test";
import { expect, test, vi } from "vitest";
import { meetingSummaryModelRoute } from "../../src/shared/meetingSummary";
import { createTempDataFolder } from "../helpers/core";
import { replyingModel } from "../helpers/models";
import { transcribingCore, until } from "../helpers/transcription";

const name = "Client work";
const transcript = "The launch is on Monday.";
const reply = "Launch on Monday.";

async function setup(local: boolean, model: MockLanguageModelV4, walled: boolean) {
  const { core, record } = await transcribingCore(await createTempDataFolder(), {
    engine: { lines: [transcript], live: true },
    createChatModel: () => model,
  });
  const modelId = local ? "test-local" : "claude-haiku-5-5";
  const provider = await core.saveChatProvider(
    local
      ? { kind: "openai-compatible", baseUrl: "http://localhost:1234/v1", modelId }
      : { kind: "anthropic", modelId, apiKey: "anthropic-test-key" },
  );
  const readiness = await core.getChatReadiness();
  if (!readiness.ready) throw new Error("Expected a ready model.");
  await core.updateSettings({
    device: {
      meetingSummaryRoute: meetingSummaryModelRoute(
        { providerId: provider.id, modelId },
        readiness.provider.service?.id ?? null,
      ),
    },
  });
  const folder = await core.createLibraryGroup({ name, description: "" });
  const wall = () =>
    core.updateLibraryGroup(folder.id, { name, description: "", keepInside: true });
  if (walled) await wall();
  const { id } = await core.createMeeting({ folderId: folder.id });
  await core.startMeeting({ meetingId: id, systemAudio: false });
  const summary = async () =>
    (await core.listMeetings()).find((meeting) => meeting.id === id)?.summary;
  const speak = () => record(2400, ["microphone"]);
  return { core, id, summary, speak, wall };
}

test.each([
  { provider: "cloud", local: false },
  { provider: "local", local: true },
])("a walled Meeting's automatic summary with a $provider model", async ({ local }) => {
  const model = replyingModel(reply);
  const { core, id, summary, speak } = await setup(local, model, true);
  speak();
  await until(core, id, (state) => !!state.documentId && state.lines > 0);
  await core.stopMeeting(id);
  await until(core, id, (state) => state.state === "saved");
  if (local) {
    await vi.waitFor(async () =>
      expect(await summary()).toMatchObject({ state: "ready", text: reply }),
    );
    expect(model.doGenerateCalls.length).toBeGreaterThan(0);
  } else {
    expect(await summary()).toMatchObject({ state: "failed", text: "", throughMs: 0 });
    expect(model.doGenerateCalls).toHaveLength(0);
  }
});

test("walling a Meeting's Folder cancels a pending cloud summary and protects the final words", async () => {
  const response = Promise.withResolvers<void>();
  const scripted = replyingModel(reply);
  const model = new MockLanguageModelV4({
    doGenerate: async (request) => {
      await response.promise;
      return scripted.doGenerate(request);
    },
  });
  const { core, id, summary, speak, wall } = await setup(false, model, false);

  try {
    speak();
    await vi.waitFor(() => expect(model.doGenerateCalls).toHaveLength(1));
    const pending = model.doGenerateCalls[0]?.abortSignal;
    expect(pending?.aborted).toBe(false);

    await wall();
    await vi.waitFor(() => expect(pending?.aborted).toBe(true));
    response.resolve();
    speak();
    await core.stopMeeting(id);
    await until(core, id, (state) => state.state === "saved");
    expect(await summary()).toMatchObject({ text: "", state: "failed" });
    expect(model.doGenerateCalls).toHaveLength(1);
  } finally {
    response.resolve();
  }
});
