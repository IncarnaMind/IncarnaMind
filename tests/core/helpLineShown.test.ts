/**
 * A line of call help shows as it is written (#2526): a press is offered no Tool that changes a
 * Note or runs a command, so the claimed-change check never runs for it, and nothing in its reply
 * waits for that check. An Answer whose claims are checked still holds a sentence that may claim a
 * change until the check has read it. Through the core's public interface, the reply paused mid-line
 * as a model streams it, read as the panel reads it.
 */
import { describe, expect, test, vi } from "vitest";
import type { Core } from "../../src/core";
import { answerEnded } from "../helpers/citations";
import { createTempDataFolder, startCore } from "../helpers/core";
import { type GenerateCall, scriptedModel, scriptedModels, unscripted } from "../helpers/models";
import { transcribingCore, until } from "../helpers/transcription";

const SECOND = 1000;

/** A reply that stops at `cut` characters until it is let go, and says when it got there. */
function pausedAt(cut: number) {
  let release: () => void = () => undefined;
  let reached: () => void = () => undefined;
  const letGo = new Promise<void>((resolve) => {
    release = resolve;
  });
  const there = new Promise<void>((resolve) => {
    reached = resolve;
  });
  return { pause: { after: cut, until: letGo, reached }, there, release };
}

/** The judge's other questions: the claimed-change check finds none; Stop's own work isn't this test's. */
const judging = (call: GenerateCall) => {
  if (call.question === undefined) return { error: { status: 500, message: "Not here." } };
  if (call.question === "claimed-changes") return { text: '{"claims":[]}' };
  if (call.question === "request-done") return { text: '{"asks_change":"no","request":"none"}' };
  return unscripted(call.question, call.system);
};

/** The Answer's text as each change of it reaches the window. */
function shownText(core: Core) {
  let answerId: string | null = null;
  let text = "";
  core.on("conversation.message", (message) => {
    if (message.kind === "answer" && message.id === answerId) text = message.text;
  });
  return {
    follow: (id: string) => {
      answerId = id;
    },
    now: () => text,
  };
}

/** A press of a help button during a call, its reply `written` paused at `cut` characters. */
async function pressPaused(written: string, cut: number) {
  const paused = pausedAt(cut);
  const model = scriptedModel(
    (call) => (call.json ? { text: "{}" } : { text: written, pause: paused.pause }),
    { chunkSize: 1, judgesItsAnswers: true, generate: judging },
  );
  const { core, record } = await transcribingCore(await createTempDataFolder(), {
    createChatModel: scriptedModels(model).createChatModel,
  });
  await core.saveChatProvider({ kind: "ollama", modelId: "local-model" });
  const meeting = await core.createMeeting({ folderId: null });
  await core.startMeeting({ meetingId: meeting.id, systemAudio: true });
  await until(core, meeting.id, (transcript) => transcript.state === "live");
  record(9 * SECOND);
  await until(core, meeting.id, (transcript) => transcript.lines >= 4);
  const shown = shownText(core);
  const asked = await core.askMeetingHelp({
    meetingId: meeting.id,
    kind: "say",
    conversationId: null,
  });
  if (!asked.asked) throw new Error("Not pressed.");
  shown.follow(asked.answerId);
  await paused.there;
  return { core, shown, release: paused.release, answerId: asked.answerId };
}

/** An Answer asked in the assistant with a Note in front, so its claims are checked, paused at `cut`. */
async function askPaused(written: string, cut: number) {
  const paused = pausedAt(cut);
  const model = scriptedModel(
    (call) => (call.json ? { text: "{}" } : { text: written, pause: paused.pause }),
    { chunkSize: 1, judgesItsAnswers: true, generate: judging },
  );
  const core = startCore(await createTempDataFolder(), {
    createChatModel: scriptedModels(model).createChatModel,
  });
  await core.saveChatProvider({ kind: "ollama", modelId: "local-model" });
  const mind = await core.createMind({ title: "Pricing" });
  const shown = shownText(core);
  /** The Answer's phases and texts, in the order they reach the window. */
  const seen: string[] = [];
  let answerId: string | null = null;
  core.on("answer.phase", (event) => {
    if (event.answerId === answerId) seen.push(event.phase);
  });
  core.on("conversation.message", (message) => {
    if (message.kind === "answer" && message.id === answerId) seen.push(`text:${message.text}`);
  });
  const asked = await core.askInConversation({
    text: "What does Enterprise cost?",
    mindId: mind.id,
  });
  if (!asked.asked) throw new Error("Not asked.");
  answerId = asked.answerId;
  shown.follow(asked.answerId);
  await paused.there;
  return { core, shown, release: paused.release, answerId: asked.answerId, seen };
}

/** Each line paused right after the word that, on its own, used to hold it back. */
const PRESSED: [string, string, string][] = [
  ["I", "★ I can confirm Enterprise is $45 a seat with", " single sign-on.\n→ keeps it moving"],
  ["now", "★ We now include single sign-on at $45 a seat", ".\n→ keeps it moving"],
  ["been", "★ The price has been $45 a seat since", " January.\n→ keeps it moving"],
  [
    "a change verb",
    "★ Enterprise moved to $45 a seat this year, single",
    " sign-on included.\n→ keeps it moving",
  ],
  [
    "a double quotation mark",
    '★ "Enterprise is $45 a seat, with single',
    ' sign-on." That is the offer.\n→ keeps it moving',
  ],
  ["我", "★ 我们企业版每个席位每月 45 美元，含单点", "登录。\n→ 推进谈判"],
  ["已", "★ 企业版价格已包含单点登录，每个席位每月", " 45 美元。\n→ 推进谈判"],
];

describe("A press's line shows as it is written (#2526)", { timeout: 60_000 }, () => {
  // protects=a line of call help streams as written, a word that may claim a change in it or not, since no check of claimed changes runs for a press; fails_when=it waits for that check, all of it or from the word on; no_claim=the panel's drawing of the line.
  test.each(PRESSED)("with %s in it", async (_trigger, before, after) => {
    const { core, shown, release, answerId } = await pressPaused(
      `${before}${after}`,
      before.length,
    );
    await vi.waitFor(() => expect(shown.now()).toBe(before), { timeout: 5_000 });
    release();
    await answerEnded(core, answerId);
  });

  // protects=a sentence that claims a change, finished, holds nothing after it in call help; fails_when=the lines after it wait; no_claim=what the panel does with such a line.
  test("a finished sentence that claims a change holds nothing after it", async () => {
    const before = "★ I've added the new price to your notes.\n★ Enterprise is $45 a seat with";
    const { core, shown, release, answerId } = await pressPaused(
      `${before} single sign-on.\n→ keeps it moving`,
      before.length,
    );
    await vi.waitFor(() => expect(shown.now()).toBe(before), { timeout: 5_000 });
    release();
    await answerEnded(core, answerId);
  });

  // protects=a press's line shows half a word as it streams, as an Answer in a Note does: whole words were part of the claim hint, which a press doesn't have; fails_when=the half word waits; no_claim=a Tool's name still being typed, which every Answer holds ("se" could start search_documents).
  test("half a word shows as it is written", async () => {
    const before = "★ Enterprise is forty-five dollars a seat, billed yea";
    const { core, shown, release, answerId } = await pressPaused(
      `${before}rly.\n→ keeps it moving`,
      before.length,
    );
    await vi.waitFor(() => expect(shown.now()).toBe(before), { timeout: 5_000 });
    release();
    await answerEnded(core, answerId);
  });
});

describe("An Answer whose claims are checked still holds a sentence that may claim one", {
  timeout: 60_000,
}, () => {
  // protects=in the assistant, with a Note in front, a sentence that may claim a change waits for the check while what comes before it shows; fails_when=it shows before the check; no_claim=the check's verdict.
  test.each([
    [
      "en",
      "The Enterprise plan is $45 a seat. ",
      "I have updated your notes with",
      " the new price.",
    ],
    ["zh-CN", "企业版每个席位每月45美元。", "我已经在你的笔记里更新了", "价格。"],
  ])("%s", async (_language, first, claim, rest) => {
    const { core, shown, release, answerId, seen } = await askPaused(
      `${first}${claim}${rest}`,
      first.length + claim.length,
    );
    // What precedes the claim shows while the model is still writing it.
    await vi.waitFor(() => expect(shown.now()).toBe(first), { timeout: 5_000 });
    release();
    await answerEnded(core, answerId);
    // The claim first shows once the check of claimed changes has started reading it.
    const checking = seen.indexOf("checking-claims");
    const claimShown = seen.findIndex((each) => each.startsWith("text:") && each.includes(claim));
    expect(checking).toBeGreaterThanOrEqual(0);
    expect(claimShown).toBeGreaterThan(checking);
  });
});
