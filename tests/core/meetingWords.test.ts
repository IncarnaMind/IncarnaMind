import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import type { Core } from "../../src/core";
import { readVtt } from "../../src/core/documents/formats/vtt";
import type { FakeSpeechOptions } from "../../src/core/transcription/fake";
import { createTempDataFolder } from "../helpers/core";
import { createSourceFolder, waitForProcessing, writeSourceFile } from "../helpers/documents";
import { transcribingCore, until } from "../helpers/transcription";

const SECOND = 1000;

/** The other side's lines say "Dana is joining us from the Leeds office.", which the engine mishears. */
const MISHEARING: FakeSpeechOptions = { mishears: { Dana: "Donna", Leeds: "Leads" } };

async function linesOf(core: Core, meetingId: string, record: (ms: number) => void) {
  record(12 * SECOND);
  const transcript = await until(core, meetingId, (each) => each.lines >= 6);
  await core.stopMeeting(meetingId);
  await until(core, meetingId, (each) => each.state === "saved");
  const document = (await core.listDocuments()).find((each) => each.id === transcript.documentId);
  return readVtt(readFileSync(document?.path ?? "", "utf8")).cues.map((cue) => cue.text);
}

describe("The transcriber on this computer knows the names in the call (#1031)", {
  timeout: 60_000,
}, () => {
  test("a Words to know word is written as the User writes it; a name not told is still misheard", async () => {
    const { core, record } = await transcribingCore(await createTempDataFolder(), {
      engine: MISHEARING,
    });
    await core.updateSettings({ user: { meetingWords: ["Leeds", "星河科技"] } });
    const meeting = await core.createMeeting();
    await core.startMeeting({ meetingId: meeting.id });

    const lines = await linesOf(core, meeting.id, record);
    expect(lines).toContain("Donna is joining us from the Leeds office.");
    expect(lines.join(" ")).not.toContain("Leads");
  });

  test("the names in the meeting's Note and the names its Folder's Documents use are told too", async () => {
    const { core, record } = await transcribingCore(await createTempDataFolder(), {
      engine: MISHEARING,
    });
    const folder = await core.createLibraryGroup({ name: "Expansion", description: "" });
    const file = await writeSourceFile(
      await createSourceFolder(),
      "Office plan.md",
      "# Office plan\n\nThe team moves to the new office in Leeds. Rent in Leeds is lower.",
    );
    const { documents } = await core.addDocuments([file]);
    await waitForProcessing(
      core,
      documents.map((each) => each.id),
    );
    await core.moveToFolder({ documentIds: documents.map((each) => each.id), folderId: folder.id });
    const mind = await core.createMind({ title: "Weekly call with Dana", folderId: folder.id });
    const meeting = await core.createMeeting({ mindId: mind.id });
    await core.startMeeting({ meetingId: meeting.id });

    const lines = await linesOf(core, meeting.id, record);
    expect(lines).toContain("Dana is joining us from the Leeds office.");
    expect(lines.join(" ")).not.toMatch(/Donna|Leads/);
  });

  test("a Meeting outside any Folder, with nothing to tell, is transcribed as it was heard", async () => {
    const { core, record } = await transcribingCore(await createTempDataFolder(), {
      engine: MISHEARING,
    });
    const meeting = await core.createMeeting();
    await core.startMeeting({ meetingId: meeting.id });

    const lines = await linesOf(core, meeting.id, record);
    expect(lines).toContain("Donna is joining us from the Leads office.");
    expect(lines.join(" ")).not.toContain("Dana");
  });
});

describe("Chinese in a Transcript follows the User's script (#1031)", { timeout: 60_000 }, () => {
  test("a Traditional line is written in Simplified by default, and both in Traditional once chosen", async () => {
    const { core, record } = await transcribingCore(await createTempDataFolder(), {
      engine: {
        lines: ["我们下周一把盖章的合同寄给你们。"],
        theirLines: ["會議室需要能坐二十四個人。"],
      },
    });
    await core.updateSettings({ user: { language: "zh-CN" } });
    expect((await core.getSettings()).chineseScript).toBe("simplified");
    const first = await core.createMeeting();
    await core.startMeeting({ meetingId: first.id });
    const simplified = await linesOf(core, first.id, record);
    expect(simplified).toContain("会议室需要能坐二十四个人。");
    expect(simplified).toContain("我们下周一把盖章的合同寄给你们。");
    expect(simplified.join("")).not.toContain("會議室");

    await core.updateSettings({ user: { transcriptScript: "traditional" } });
    expect((await core.getSettings()).chineseScript).toBe("traditional");
    const second = await core.createMeeting();
    await core.startMeeting({ meetingId: second.id });
    const traditional = await linesOf(core, second.id, record);
    expect(traditional).toContain("我們下週一把蓋章的合同寄給你們。");
    expect(traditional).toContain("會議室需要能坐二十四個人。");
    expect(traditional.join("")).not.toContain("会议室");
  });
});
