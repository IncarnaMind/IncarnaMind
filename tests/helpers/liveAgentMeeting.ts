import type { CoreAdapters } from "../../src/core/adapters";
import { createFakeCapture } from "../../src/core/meetings/fakeCapture";
import { createFakeCloud } from "../../src/core/transcription/fakeCloud";
import { agentsAdapter } from "./agents";
import { createTempDataFolder, manualClock, startCore, type TestAdapters } from "./core";
import { inProcessTranscriber, NO_TRANSCRIPTION_FILES, until } from "./transcription";

/** `more`: adapters of the test's own, such as the User's own AI run in the background. */
export async function startLiveAgentMeeting(
  run: NonNullable<CoreAdapters["summarizeWithMeetingAgent"]>,
  grant: boolean,
  lines: string[],
  client: "codex" | "claude-code" = "codex",
  more: TestAdapters = {},
) {
  const dir = await createTempDataFolder();
  const clock = manualClock();
  const capture = createFakeCapture({ now: () => clock.now().getTime() });
  const { transcriber } = inProcessTranscriber(
    {},
    undefined,
    createFakeCloud({ voices: 1, lines }),
  );
  const adapters = {
    now: clock.now,
    agents: await agentsAdapter(dir),
    audioCapture: capture,
    transcriber,
    transcriptionModelSource: NO_TRANSCRIPTION_FILES,
    transcriptionKeyFetch: async () => new Response(null, { status: 200 }),
    summarizeWithMeetingAgent: run,
    ...more,
  };
  const core = startCore(dir, adapters);
  const folder = await core.createLibraryGroup({ name: "Launch", description: "" });
  await core.setAgentsEnabled(true);
  const { pairing } = await core.connectAgent({
    name: "Codex",
    client,
    folderIds: [folder.id],
  });
  await core.setTranscriptionKey({ route: "soniox", apiKey: "soniox-test-key-0123456789" });
  await core.updateSettings({
    device: {
      meetingNoticeAccepted: true,
      meetingNotesAgentId: pairing.id,
      meetingSummaryRoute: grant ? pairing.id : null,
      transcriptionRoute: "soniox",
    },
  });
  const meeting = await core.createMeeting({ folderId: folder.id });
  await core.startMeeting({ meetingId: meeting.id, systemAudio: true });
  await until(core, meeting.id, (m) => m.cloud === "soniox");
  await core.setMeetingMicrophone({ meetingId: meeting.id, paused: true });
  const push = (millis: number) => {
    for (let i = 0; i < millis; i += 500) {
      clock.advance(500);
      capture.push("system", 500);
    }
  };
  const summary = async () => (await core.listMeetings()).find((m) => m.id === meeting.id)?.summary;
  return { dir, core, pairing, adapters, meeting, push, summary };
}
