/**
 * The User's own items in a Meeting's notes, by the name they set in Settings › General (#2306),
 * through the core's public interface: the model is asked for a token and never sent the name,
 * and the name goes in the token's place on this computer wherever the notes write it.
 */
import { describe, expect, test, vi } from "vitest";
import type { Core, Meeting, MeetingFill } from "../../src/core";
import type { LogFields } from "../../src/core/adapters";
import type { FillSection } from "../../src/core/meetings/fillPrompt";
import { checkReply, isCheckRun } from "../helpers/checks";
import { shownPassages, transcriptCitations } from "../helpers/citations";
import { createTempDataFolder } from "../helpers/core";
import { addAndProcess, createSourceFolder, writeSourceFile } from "../helpers/documents";
import { connectToMind } from "../helpers/mindClient";
import { exactly, heading, note, readMind, writeMind } from "../helpers/minds";
import { type ModelCall, scriptedModel } from "../helpers/models";
import { transcribingCore } from "../helpers/transcription";

const CALLS = {
  en: {
    said: [
      "We met to settle the glossary and the price",
      "I will send the glossary by Friday",
      "We agreed the price is 45 dollars a seat",
      "Our team approved the budget",
      "My review starts in March",
    ],
    heading: "Review",
    line: "glossary and price",
    /** What the model writes: the token as asked, and as a model may miswrite it. */
    named: {
      overview: "The call settled {{user}}'s glossary and {{**me**}}'s price",
      action: { topic: "{{ Me }}'s glossary", body: "{{me}} will send the glossary by Friday" },
      decision: {
        topic: "price",
        body: "We agreed the price is 45 dollars a seat, billed to {{first_name}} at {{ }}",
      },
      claim: { topic: "｛｛ME｝｝'s budget", body: "{me}'s team approved the budget" },
      review: {
        topic: "review",
        heading: "{{me}}'s review",
        body: "{{me}}'s review starts in March",
      },
    },
    firstPerson: {
      overview: "The call settled my glossary and the price",
      action: { topic: "my glossary", body: "I will send the glossary by Friday" },
      decision: { topic: "price", body: "We agreed the price is 45 dollars a seat" },
      claim: { topic: "our budget", body: "Our team approved the budget" },
      review: { topic: "review", heading: "{{me}}'s review", body: "My review starts in March" },
    },
  },
  "zh-CN": {
    said: [
      "我们开会定术语表和价格",
      "周五之前我把术语表发过去",
      "我们同意每个席位 45 美元",
      "我们团队批准了预算",
      "我的评审三月开始",
    ],
    heading: "评审",
    line: "术语表和价格",
    named: {
      overview: "这次会议定下了{{user}}的术语表和{{**me**}}的价格",
      action: { topic: "{{ Me }}的术语表", body: "{{me}}周五前把术语表发过去" },
      decision: {
        topic: "价格",
        body: "我们同意每个席位 45 美元，账单写给 {{first_name}}，地址 {{ }}",
      },
      claim: { topic: "｛｛ME｝｝的预算", body: "{me}的团队批准了预算" },
      review: { topic: "评审", heading: "{{me}}的评审", body: "{{me}}的评审三月开始" },
    },
    firstPerson: {
      overview: "这次会议定下了我的术语表和价格",
      action: { topic: "我的术语表", body: "我周五前把术语表发过去" },
      decision: { topic: "价格", body: "我们同意每个席位 45 美元" },
      claim: { topic: "我们的预算", body: "我们团队批准了预算" },
      review: { topic: "评审", heading: "{{me}}的评审", body: "我的评审三月开始" },
    },
  },
} as const;

type Language = keyof typeof CALLS;
type Reply = (typeof CALLS)[Language]["named" | "firstPerson"];

/** What the note reads, the name in the token's place, in the call's language. */
function named(language: Language, name: string): string[] {
  if (language === "en") {
    return [
      `The call settled ${name}'s glossary and ${name}'s price`,
      `${name}'s glossary — see below`,
      `${name} will send the glossary by Friday`,
      "We agreed the price is 45 dollars a seat, billed to {{first_name}} at {{ }}",
      `${name}'s team approved the budget`,
      `${name}'s review starts in March`,
    ];
  }
  // A Latin name sits a space apart from the Chinese around it; a Chinese one doesn't.
  const as = /\p{Script=Han}/u.test(name) ? name : ` ${name} `;
  const start = as.trimStart();
  return [
    `这次会议定下了${as}的术语表和${as}的价格`,
    `${start}的术语表，详见下文`,
    `${start}周五前把术语表发过去`,
    "我们同意每个席位 45 美元，账单写给 {{first_name}}，地址 {{ }}",
    `${start}的团队批准了预算`,
    `${start}的评审三月开始`,
  ];
}

function frame(
  id: string,
  { topic, heading = topic, body }: { topic: string; heading?: string; body: string },
  citation: number,
  {
    lines = [],
    sections,
    claim = false,
  }: { lines?: string[]; sections: FillSection[]; claim?: boolean },
): string {
  const end = /\p{Script=Han}$/u.test(body) ? "。" : ".";
  return [
    `### FACT ${id}`,
    "```json",
    JSON.stringify({
      topic,
      heading,
      citations: [citation],
      lines,
      sections,
      claim,
      supersedes: [],
    }),
    "```",
    `${body} [^${citation}]${end}`,
    `### END ${id}`,
  ].join("\n");
}

function replyFor(language: Language, reply: Reply): string {
  const end = language === "en" ? "." : "。";
  return [
    "HEADINGS: H1=NONE",
    frame("P1_glossary", reply.action, 2, { lines: ["L1"], sections: ["actions"] }),
    frame("P1_price", reply.decision, 3, { lines: ["L1"], sections: ["decisions"] }),
    frame("P1_budget", reply.claim, 4, { sections: [], claim: true }),
    frame("P1_review", reply.review, 5, { sections: [] }),
    [
      "### OVERVIEW",
      "```json",
      '{"citations":[1]}',
      "```",
      `${reply.overview} [^1]${end}`,
      "### END OVERVIEW",
    ].join("\n"),
  ].join("\n\n");
}

const isFill = (call: ModelCall) =>
  call.prompt.includes("Fill them in from the transcript") || call.prompt.includes("took no notes");

const block = (text: string, tag: string) =>
  new RegExp(`<${tag}>\\n([\\s\\S]*?)\\n</${tag}>`).exec(text)?.[1] ?? null;

async function settledFill(core: Core, meeting: Meeting): Promise<MeetingFill> {
  return vi.waitFor(
    async () => {
      const fill = (await core.listMeetings()).find((each) => each.id === meeting.id)?.fill;
      if (!fill || fill.state === "waiting" || fill.state === "filling") {
        throw new Error(`Not yet: ${JSON.stringify(fill)}`);
      }
      return fill;
    },
    { timeout: 20_000 },
  );
}

/** A call in `language`, its notes filled in with the User's name set to `name` (null: none). */
async function filled(language: Language, name: string | null) {
  const call = CALLS[language];
  const reply = replyFor(language, name === null ? call.firstPerson : call.named);
  const quotes = Object.fromEntries(call.said.map((line, index) => [index + 1, line]));
  const fills: string[] = [];
  const warnings: { event: string; fields?: LogFields }[] = [];
  const checks: string[] = [];
  const model = scriptedModel((request) => {
    if (isCheckRun(request)) {
      checks.push(request.prompt);
      return checkReply(request, {});
    }
    if (!isFill(request)) return { text: "OK" };
    if (!request.results.some((result) => result.tool === "cite")) fills.push(request.prompt);
    const shown = shownPassages(block(request.prompt, "live-transcript") ?? "");
    return transcriptCitations(request, shown, quotes) ?? { text: reply };
  });
  const { core, record } = await transcribingCore(await createTempDataFolder(), {
    model,
    engine: { lines: call.said },
    log: {
      info: () => undefined,
      warn: (event, fields) => warnings.push({ event, fields }),
      error: () => undefined,
    },
  });
  await core.saveLibrarySettings({ ...(await core.getLibrary()).settings, automatic: false });
  await core.updateSettings({ user: { language, authorName: name } });
  await core.saveChatProvider({ kind: "ollama", modelId: "local-model" });
  // A Document in the Note's Folder to check the claim against, so the check asks the model.
  const sources = await createSourceFolder();
  const added = await addAndProcess(core, [
    await writeSourceFile(sources, "Budget.md", "The budget review is in March.\n"),
  ]);
  const folder = await core.createLibraryGroup({ name: "Review", description: "" });
  await core.moveToFolder({ documentIds: added.map((each) => each.id), folderId: folder.id });
  const meeting = await core.createMeeting({ folderId: folder.id });
  const client = await connectToMind(core, meeting.mindId);
  writeMind(client, [heading(1, call.heading), note(call.line)]);
  await client.settled();
  const before = exactly(client);
  await core.startMeeting({ meetingId: meeting.id, systemAudio: false });
  record(14_000, ["microphone"]);
  await vi.waitFor(async () => {
    const current = (await core.listMeetings()).find((each) => each.id === meeting.id);
    expect(current?.transcript?.lines ?? 0).toBeGreaterThanOrEqual(call.said.length);
  });
  await core.stopMeeting(meeting.id);
  const fill = await settledFill(core, meeting);
  /** Every request the model was sent, as it was sent. */
  const sent = () =>
    [...model.doStreamCalls, ...model.doGenerateCalls].map((each) => JSON.stringify(each.prompt));
  return { core, meeting, client, before, fill, fills, checks, sent, warnings };
}

const headingsOf = (client: Parameters<typeof readMind>[0]) => {
  const found: string[] = [];
  readMind(client).forEach((block) => {
    if (block.type.name === "heading") found.push(block.textContent);
  });
  return found;
};

/** A token that means the User; other braced text is the call's own. */
const TOKENS = /[{｛]+\s*(?:me|user|我|用户)\s*[}｝]+/iu;

describe("The User's own items carry the name they set, which never reaches the model (#2306)", {
  timeout: 60_000,
}, () => {
  // protects=with the User's name set, the notes name them by it in every place the fill writes (a section's fact, the overview, a pointer under the typed line, the claims list and a topic's bullet, while a topic's heading never shows the User), the model's near-miss tokens included, "{{user}}" and a token split by formatting named by the last pass and logged, other braced text kept as written, the model is told the token and never the name, the claim check gets the token, Try again after Undo does the same, and Undo leaves the notes exactly as typed; fails_when=a token or a near-miss is left in the note, the name or the first-person rule reaches any request, or Undo leaves anything; no_claim=a real model's wording, which tests/live/meetingFillSections.live.test.ts measures.
  test.each([
    ["en", "Avery Lin"],
    ["zh-CN", "林安"],
    ["zh-CN", "Avery Lin"],
  ] as const)("in %s, named %s", async (language, name) => {
    const { core, meeting, client, before, fill, fills, checks, sent, warnings } = await filled(
      language,
      name,
    );
    try {
      expect(fill).toMatchObject({ state: "filled", omitted: 0, problem: null });
      await vi.waitFor(() => {
        const text = readMind(client).textContent;
        for (const line of named(language, name)) expect(text).toContain(line);
      });
      expect(readMind(client).textContent).not.toMatch(TOKENS);
      // A heading never shows the User: the token falls back to the fact's topic (#2306).
      expect(headingsOf(client).map((each) => each.toLowerCase())).toContain(
        CALLS[language].named.review.topic,
      );
      expect(headingsOf(client).join("\n")).not.toContain(name);
      // Only the decision's own "{{first_name}}" and "{{ }}" keep their braces.
      expect(readMind(client).textContent.match(/[{｛]/gu)).toHaveLength(4);
      expect(warnings.filter((each) => each.event === "meeting.fillTokenLeftover")).toEqual([
        { event: "meeting.fillTokenLeftover", fields: { meetingId: meeting.id, leftovers: 1 } },
      ]);

      expect(fills).toHaveLength(1);
      expect(fills[0]).toContain("Write the User, who reads these notes, as {{me}}");
      expect(fills[0]).not.toContain("in the first person");
      expect(checks.length).toBeGreaterThan(0);
      expect(checks.join("\n")).toContain(CALLS[language].named.claim.body);
      for (const request of sent()) expect(request).not.toContain(name);

      await core.undoMeetingFill(meeting.id);
      await vi.waitFor(() => expect(exactly(client)).toEqual(before));

      await core.fillMeetingNotes(meeting.id);
      await vi.waitFor(async () =>
        expect(
          (await core.listMeetings()).find((each) => each.id === meeting.id)?.fill,
        ).toMatchObject({
          state: "filled",
          omitted: 0,
        }),
      );
      await vi.waitFor(() =>
        expect(readMind(client).textContent).toContain(named(language, name)[2]),
      );
      expect(fills).toHaveLength(2);
      expect(fills[1]).toContain("Write the User, who reads these notes, as {{me}}");
      for (const request of sent()) expect(request).not.toContain(name);
    } finally {
      core.close();
    }
  });

  // protects=with no name set, the model is asked for the User in the first person as before, never a token, and what it writes goes in as written (#2684); fails_when=a token is asked for, or the note's words change; no_claim=the computer's login name, which the Settings tests cover.
  test.each(["en", "zh-CN"] as const)(
    "in %s, with no name set, the User is in the first person",
    async (language) => {
      const { firstPerson } = CALLS[language];
      const { core, meeting, client, before, fill, fills } = await filled(language, null);
      try {
        expect(fill).toMatchObject({ state: "filled", omitted: 0 });
        await vi.waitFor(() => {
          const text = readMind(client).textContent;
          for (const said of [
            firstPerson.overview,
            firstPerson.action.body,
            firstPerson.claim.body,
            firstPerson.review.body,
          ]) {
            expect(text).toContain(said);
          }
        });
        expect(headingsOf(client).map((each) => each.toLowerCase())).toContain(
          firstPerson.review.topic,
        );
        expect(headingsOf(client).join("\n")).not.toMatch(/[{｛]/u);
        expect(fills[0]).toContain("in the first person (I, my; 我 in Chinese)");
        expect(fills[0]).not.toContain("{{me}}");
        await core.undoMeetingFill(meeting.id);
        await vi.waitFor(() => expect(exactly(client)).toEqual(before));
      } finally {
        core.close();
      }
    },
  );
});
