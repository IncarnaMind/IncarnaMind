import { expect, test, vi } from "vitest";
import * as Y from "yjs";
import type { MeetingFill } from "../../src/core";
import { CITATION_NODE, GENERATED_MARK } from "../../src/core/api";
import { shownPassages } from "../helpers/citations";
import { createTempDataFolder } from "../helpers/core";
import { connectToMind } from "../helpers/mindClient";
import { exactly, heading, note, readMind, writeMind } from "../helpers/minds";
import { scriptedModel } from "../helpers/models";
import { transcribingCore } from "../helpers/transcription";

function frame(
  id: string,
  topic: string,
  text: string,
  citation: number,
  section: string,
  lines = ["L1"],
) {
  return [
    `### FACT ${id}`,
    "```json",
    JSON.stringify({ topic, citations: [citation], lines, sections: [section], claim: false }),
    "```",
    `${text} [^${citation}].`,
    `### END ${id}`,
  ].join("\n");
}

function overview(text: string) {
  return [
    "### OVERVIEW",
    "```json",
    JSON.stringify({ citations: [4] }),
    "```",
    `${text} [^4].`,
    "### END OVERVIEW",
  ].join("\n");
}

async function capture(
  language: "en" | "zh-CN",
  {
    badSibling = false,
    withoutIds = false,
    splitHeading,
    nestedLine = false,
    malformedFrame = false,
    badRouting = false,
  }: {
    badSibling?: boolean;
    withoutIds?: boolean;
    splitHeading?: "user" | "empty" | "generated";
    nestedLine?: boolean;
    malformedFrame?: boolean;
    badRouting?: boolean;
  } = {},
) {
  const words =
    language === "en"
      ? {
          line: "review date and assignments",
          purpose: "We are settling the review date and sharing the work",
          decision: "The review is on Tuesday",
          first: "Dana will send the draft on Monday",
          second: "Alex will bring the checklist on Tuesday",
          topics: ["review date", "draft", "checklist"],
        }
      : {
          line: "评审日期与分工",
          purpose: "今天定评审日期，再分一下工",
          decision: "评审定在周二",
          first: "王芳周一发草稿",
          second: "李明周二带来检查清单",
          topics: ["评审日期", "草稿", "检查清单"],
        };
  const text = [
    badRouting ? "HEADINGS: H9=NONE" : splitHeading ? "HEADINGS: H1=ACTIONS" : "HEADINGS: H1=NONE",
    ...(malformedFrame ? ["### FACT 1invalid\nThis frame has no valid identity."] : []),
    frame("F1", words.topics[0] ?? "", words.decision, 1, "decisions"),
    frame("F2", words.topics[1] ?? "", words.first, badSibling ? 99 : 2, "actions"),
    frame("F3", words.topics[2] ?? "", words.second, 3, "actions"),
    overview(words.purpose),
  ].join("\n\n");
  const feedback: string[] = [];
  const pending = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  const model = scriptedModel((call) => {
    const last = call.results.at(-1);
    if (last) feedback.push(`${last.tool}: ${last.text}`);
    const shown = shownPassages(call.prompt);
    if (shown.length === 0) return { text: "OK" };
    if (call.results.some((result) => result.tool === "cite")) {
      if (splitHeading) {
        pending.resolve();
        return { text, pause: { after: 1, until: resume.promise } };
      }
      return { text };
    }
    const quotes: Record<number, string> = {
      1: words.decision,
      3: words.second,
      4: words.purpose,
    };
    if (!badSibling) quotes[2] = words.first;
    const citations = Object.entries(quotes).map(([marker, quote]) => {
      const passage = shown.find((each) => each.text.includes(quote));
      const cue = passage?.text.split("\n").find((line) => line.includes(quote));
      const location = /^\[([^\]]+)\]/.exec(cue ?? "")?.[1];
      if (!passage || !location)
        throw new Error("The fixture's selected Transcript cue is missing.");
      return { marker: Number(marker), passage: passage.id, quote, location };
    });
    return { calls: [{ tool: "cite", input: { citations } }] };
  });
  const { core, record } = await transcribingCore(await createTempDataFolder(), {
    model,
    engine: { lines: [words.purpose, words.decision, words.first, words.second] },
  });
  await core.saveLibrarySettings({ ...(await core.getLibrary()).settings, automatic: false });
  await core.updateSettings({ user: { language } });
  await core.saveChatProvider({ kind: "ollama", modelId: "local-model" });
  const meeting = await core.createMeeting();
  const client = await connectToMind(core, meeting.mindId);
  writeMind(client, [
    heading(
      1,
      splitHeading
        ? language === "en"
          ? "Action items"
          : "行动项"
        : language === "en"
          ? "Review"
          : "评审",
    ),
    nestedLine
      ? { type: "bulletList", content: [{ type: "listItem", content: [note(words.line)] }] }
      : note(words.line),
  ]);
  if (withoutIds) {
    client.doc.transact(() => {
      const clearIds = (parent: Y.XmlFragment | Y.XmlElement) => {
        for (const block of parent.toArray()) {
          if (!(block instanceof Y.XmlElement)) continue;
          block.removeAttribute("id");
          clearIds(block);
        }
      };
      clearIds(client.blocks);
    });
  }
  await client.settled();
  let before = exactly(client);
  await core.startMeeting({ meetingId: meeting.id, systemAudio: false });
  record(10_000, ["microphone"]);
  await vi.waitFor(async () => {
    const current = (await core.listMeetings()).find((each) => each.id === meeting.id);
    expect(current?.transcript?.lines ?? 0).toBeGreaterThanOrEqual(4);
  });
  await core.stopMeeting(meeting.id);
  if (splitHeading) {
    await pending.promise;
    const blocks = readMind(client).toJSON().content ?? [];
    const label =
      splitHeading === "empty"
        ? ""
        : splitHeading === "generated"
          ? language === "en"
            ? "Generated topic"
            : "生成的话题"
          : language === "en"
            ? "Other topic"
            : "其他话题";
    const boundary = heading(1, label);
    if (splitHeading === "generated") {
      boundary.content = [{ type: "text", text: label, marks: [{ type: GENERATED_MARK }] }];
    }
    writeMind(client, [...blocks.slice(0, 1), boundary, ...blocks.slice(1)]);
    await client.settled();
    before = exactly(client);
    resume.resolve();
  }
  const fill = await vi.waitFor(async (): Promise<MeetingFill> => {
    const current = (await core.listMeetings()).find((each) => each.id === meeting.id)?.fill;
    if (!current || current.state === "waiting" || current.state === "filling") {
      throw new Error("The meeting notes are not settled.");
    }
    return current;
  });
  return { core, meeting, client, before, fill, model, words, feedback };
}

for (const language of ["en", "zh-CN"] as const) {
  test.each(["malformedFrame", "badRouting"] as const)(
    `a %s failure is disclosed without inventing an omitted fact count (${language})`,
    async (failure) => {
      const { core, meeting, client, before, fill, words } = await capture(language, {
        [failure]: true,
      });
      try {
        expect(fill).toMatchObject({ state: "filled", omitted: 0, problem: { kind: "model" } });
        for (const full of [words.decision, words.first, words.second]) {
          expect(readMind(client).textContent.split(full)).toHaveLength(2);
        }
        expect(readMind(client).textContent).not.toContain("This frame has no valid identity.");
        await core.undoMeetingFill(meeting.id);
        await vi.waitFor(() => expect(exactly(client)).toEqual(before));
      } finally {
        core.close();
      }
    },
  );

  test.each([false, true])(
    `an ordinary list line is filled in place, with exact Undo (missing ids: %s, ${language})`,
    async (withoutIds) => {
      const { core, meeting, client, before, fill, words } = await capture(language, {
        nestedLine: true,
        withoutIds,
      });
      try {
        expect(fill).toMatchObject({ state: "filled", omitted: 0 });
        const items: string[] = [];
        readMind(client).descendants((node) => {
          if (node.type.name === "listItem") items.push(node.textContent);
        });
        expect(items).toHaveLength(1);
        for (const full of [words.decision, words.first, words.second]) {
          expect(items[0]).toContain(full);
          expect(readMind(client).textContent.split(full)).toHaveLength(2);
        }
        await core.undoMeetingFill(meeting.id);
        await vi.waitFor(() => expect(exactly(client)).toEqual(before));
      } finally {
        core.close();
      }
    },
  );

  test.each(["user", "empty", "generated"] as const)(
    `a new %s heading during generation keeps the reference direction and survives Undo (${language})`,
    async (splitHeading) => {
      const { core, meeting, client, before, fill, words } = await capture(language, {
        splitHeading,
      });
      try {
        expect(fill).toMatchObject({ state: "filled", omitted: 0 });
        const text = readMind(client).textContent;
        const blocks = readMind(client);
        const boundary = blocks.child(1);
        expect(boundary.type.name).toBe("paragraph");
        const references = boundary.textContent;
        expect(references).toContain(language === "en" ? "draft — see below" : "草稿，详见下文");
        expect(references).not.toContain(words.first);
        expect(text.indexOf(words.first)).toBeGreaterThan(text.indexOf(words.line));
        await core.undoMeetingFill(meeting.id);
        await vi.waitFor(() => expect(exactly(client)).toEqual(before));
      } finally {
        core.close();
      }
    },
  );

  test.each([false, true])(
    `each complete fact is rendered once, with exact Undo (missing original ids: %s, ${language})`,
    async (withoutIds) => {
      const { core, meeting, client, before, fill, words } = await capture(language, {
        withoutIds,
      });
      try {
        expect(fill).toMatchObject({ state: "filled", omitted: 0 });
        await vi.waitFor(() => {
          const text = readMind(client).textContent;
          for (const full of [words.decision, words.first, words.second]) {
            expect(text.split(full)).toHaveLength(2);
          }
          expect(text).not.toMatch(/FACT F\d|END F\d|"citations"|"sections"/);
        });
        const paragraphs: string[] = [];
        readMind(client).forEach((node) => {
          paragraphs.push(node.textContent);
        });
        const start = paragraphs.indexOf(words.line);
        expect(paragraphs.slice(start + 1, start + 4)).toEqual([
          expect.stringContaining(words.decision),
          expect.stringContaining(words.first),
          expect.stringContaining(words.second),
        ]);
        await core.undoMeetingFill(meeting.id);
        await vi.waitFor(() => expect(exactly(client)).toEqual(before));
      } finally {
        core.close();
      }
    },
  );

  test(`one unrecorded item is counted, not repaired or allowed to discard cited siblings (${language})`, async () => {
    const { core, meeting, client, before, fill, model, words, feedback } = await capture(
      language,
      {
        badSibling: true,
      },
    );
    try {
      expect(fill).toMatchObject({ state: "filled", omitted: 1 });
      await vi.waitFor(() => {
        const doc = readMind(client);
        expect(doc.textContent).toContain(words.decision);
        expect(doc.textContent).toContain(words.second);
        expect(doc.textContent).not.toContain(words.first);
        doc.descendants((node) => {
          if (node.type.name === CITATION_NODE) expect(node.attrs.check).toBe("found");
        });
      });
      expect(model.doStreamCalls, JSON.stringify(feedback)).toHaveLength(2);
      expect(model.doGenerateCalls).toHaveLength(0);
      await core.undoMeetingFill(meeting.id);
      await vi.waitFor(() => expect(exactly(client)).toEqual(before));
    } finally {
      core.close();
    }
  });
}
