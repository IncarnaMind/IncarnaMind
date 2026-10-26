/**
 * A voice memo's as-is note (#1568): one Transcript cue, one paragraph, in order, with its own
 * start and end — including a memo whose every cue says the same words, and 100-second transcripts
 * whose cues span several Passages.
 */
import { readFileSync } from "node:fs";
import { expect, test, vi } from "vitest";
import type { Citation } from "../../src/core";
import { readVtt } from "../../src/core/documents/formats/vtt";
import { createTempDataFolder } from "../helpers/core";
import { connectToMind, type MindClient } from "../helpers/mindClient";
import { readMind } from "../helpers/minds";
import { transcribingCore, until } from "../helpers/transcription";

function citationsOf(client: MindClient) {
  const citations: Citation[] = [];
  readMind(client).descendants((node) => {
    if (node.type.name === "citation") citations.push(node.attrs as Citation);
  });
  return citations;
}

async function longMemo(language: "en" | "zh-CN", given?: readonly string[]) {
  const lines =
    given ??
    Array.from({ length: 50 }, (_, index) =>
      language === "en"
        ? `Cue ${index}: The blue door is open. ${"We inspect the garden before the afternoon rain and leave the windows closed. ".repeat(1 + (index % 5))}End cue ${index}.`
        : `  第${index}段：蓝色的门开着。${"我们在下午下雨前检查花园，窗户保持关闭，记录每一个细节。".repeat(1 + (index % 5))}结束第${index}段。  `,
    );
  const { core, record } = await transcribingCore(await createTempDataFolder(), {
    engine: { lines },
  });
  try {
    await core.updateSettings({ user: { language } });
    const memo = await core.recordMemo();
    const client = await connectToMind(core, memo.mindId);
    await client.settled();
    record(100_000, ["microphone"]);
    await until(core, memo.id, (transcript) => transcript.lines >= 2);
    await core.stopMeeting(memo.id);
    const saved = await until(core, memo.id, (transcript) => transcript.state === "saved");
    await vi.waitFor(
      async () => {
        const fill = (await core.listMeetings()).find((each) => each.id === memo.id)?.fill;
        if (fill?.state !== "filled") throw new Error(`Not yet: ${JSON.stringify(fill)}`);
      },
      { timeout: 120_000 },
    );
    await client.settled();
    const paragraphs: string[] = [];
    readMind(client).forEach((node) => {
      if (node.type.name === "paragraph") paragraphs.push(node.textContent.trim());
    });
    return {
      citations: citationsOf(client),
      cues: readVtt(readFileSync(saved.savedPath as string, "utf8")).cues,
      paragraphs,
    };
  } finally {
    core.close();
  }
}

test("a 100-second memo of identical cues keeps every cue as its own paragraph with its own time", {
  timeout: 180_000,
}, async () => {
  const line = "我们在下午下雨前检查花园窗户保持关闭记录每一个细节".repeat(5);
  const { citations, cues, paragraphs } = await longMemo(
    "zh-CN",
    Array.from({ length: 50 }, () => line),
  );
  expect(cues.length).toBeGreaterThan(40);
  expect(paragraphs).toEqual(cues.map((each) => each.text));
  expect(citations).toHaveLength(cues.length);
  expect(citations.map((citation) => citation.location)).toEqual(
    cues.map((each) => ({ kind: "time", from: each.startMs, to: each.endMs })),
  );
});

for (const language of ["en", "zh-CN"] as const) {
  test(`a 100-second varied ${language} memo cites every cue's own start and end`, {
    timeout: 180_000,
  }, async () => {
    const { citations, cues } = await longMemo(language);
    expect(cues.length).toBeGreaterThan(1);
    expect(citations).toHaveLength(cues.length);
    expect(citations.every((citation) => citation.check === "found")).toBe(true);
    expect(citations.map((citation) => citation.location)).toEqual(
      cues.map((each) => ({ kind: "time", from: each.startMs, to: each.endMs })),
    );
  });
}
