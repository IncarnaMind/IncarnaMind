/**
 * Call help on the quick-tasks model first (#2526, #1667 step E), through the core's public
 * interface as the floating panel presses a button: under an Answers model the list beside the
 * catalog admits with its quick model, the quick one answers, thinking off; a reply that fails or
 * shows a quote not on its page goes to the User's model, which writes it again from the start.
 * The models are scripted.
 */
import { describe, expect, test } from "vitest";
import type { AnswerPathsOverride, Core, Meeting } from "../../src/core";
import { CLAIM_CHECK_INSTRUCTIONS } from "../../src/core/answers/claimedChanges";
import type { ChatModelFactory, ChatModelSpec } from "../../src/core/providers/models";
import { answerEnded, shownPassages } from "../helpers/citations";
import { createTempDataFolder } from "../helpers/core";
import { createSourceFolder, waitForProcessing, writeSourceFile } from "../helpers/documents";
import { type ModelCall, scriptedModel } from "../helpers/models";
import { transcribingCore, until } from "../helpers/transcription";

const SECOND = 1000;
const PRICE = "Enterprise plan: $45 per seat a month, single sign-on included.";
const WRONG = "Enterprise plan: $40 per seat a month, single sign-on included.";
const SETUP = "Setup fee: $1,500, once.";
const SHEET = `Price sheet 2026\n\nTeam plan: $25 per seat a month.\n${PRICE}\n${SETUP}`;
const QUICK_TEXT = "★ Enterprise is $45 a seat, single sign-on included [^1]\n→ answers at once";
const OWN_TEXT =
  "★ Yes, Enterprise has single sign-on, at $45 a seat [^1]\n→ settles their security review";
const LISTED: AnswerPathsOverride = { helpsQuickFirst: () => true };
const HELP = "pressed a button for help";

const block = (text: string, tag: string) =>
  new RegExp(`<${tag}>\\n([\\s\\S]*?)\\n</${tag}>`).exec(text)?.[1] ?? "";

interface Reply {
  /** The records it gives the Passage found ahead: marker and quote. */
  cites: readonly { marker: number; quote: string }[];
  text: string;
}

/**
 * A model that cites the Passage found ahead as `reply` says, then writes its text; each check of
 * the changes a reply claims it is asked goes into `checks`, and finds none.
 */
function helping(reply: Reply, calls: ModelCall[], checks: string[]) {
  return scriptedModel(
    (call) => {
      calls.push(call);
      const [found] = shownPassages(block(call.prompt, "found-in-documents"));
      if (
        found &&
        reply.cites.length > 0 &&
        !call.results.some((result) => result.tool === "cite")
      ) {
        const citations = reply.cites.map((each) => ({ ...each, passage: found.id }));
        return { calls: [{ tool: "cite", input: { citations } }] };
      }
      return { text: reply.text };
    },
    {
      generate: (call) => {
        if (!call.system.includes(CLAIM_CHECK_INSTRUCTIONS))
          return { error: { status: 400, message: "Not scripted." } };
        checks.push(call.prompt);
        return { text: '{"claims":[]}' };
      },
    },
  );
}

/** A recording call whose other side asks about Enterprise, over a price sheet, under `answers`. */
async function setUp(
  { quick, own }: { quick: Reply; own: Reply },
  {
    answers = "claude-sonnet-5-5",
    paths,
    before,
  }: {
    answers?: string;
    paths?: AnswerPathsOverride;
    /** Before the call starts: the core, the Answers provider's id. */
    before?: (core: Core, providerId: string) => Promise<void>;
  } = {},
) {
  const quickCalls: ModelCall[] = [];
  const ownCalls: ModelCall[] = [];
  const specs: ChatModelSpec[] = [];
  const checks: string[] = [];
  const quickModel = helping(quick, quickCalls, checks);
  const ownModel = helping(own, ownCalls, checks);
  const createChatModel: ChatModelFactory = (spec) => {
    specs.push(spec);
    const quick =
      spec.kind === "openai" ||
      (spec.modelId === "claude-haiku-5-5" && answers !== "claude-haiku-5-5");
    return quick ? quickModel : ownModel;
  };
  const { core, record } = await transcribingCore(await createTempDataFolder(), {
    createChatModel,
    engine: {
      lines: ["Shall we go through the proposal?", "The Team plan is twenty-five dollars a seat."],
      theirLines: [
        "We'd need single sign-on for our security review.",
        "Does Enterprise include single sign-on, and what does it cost per seat?",
      ],
    },
    ...(paths && { answerPaths: paths }),
  });
  core.on("consent.requested", (asked) => void core.respondToConsent(asked.requestId, true));
  const saved = await core.saveChatProvider({
    kind: "anthropic",
    modelId: answers,
    apiKey: "sk-ant-test",
  });
  if (saved.service) {
    for (const flow of ["chat", "checks"] as const)
      await core.allowDataFlow(flow, saved.service.id);
  }
  await before?.(core, saved.id);
  const sources = await createSourceFolder();
  const added = await core.addDocuments([await writeSourceFile(sources, "Price sheet.txt", SHEET)]);
  await waitForProcessing(
    core,
    added.documents.map((document) => document.id),
  );
  const meeting = await core.createMeeting();
  await core.startMeeting({ meetingId: meeting.id, systemAudio: true });
  record(9 * SECOND);
  await until(core, meeting.id, (transcript) => transcript.lines >= 4);
  return { core, meeting, quickCalls, ownCalls, specs, checks };
}

async function press(core: Core, meeting: Meeting) {
  const result = await core.askMeetingHelp({ meetingId: meeting.id, kind: "answer" });
  if (!result.asked) throw new Error(`Not asked: ${JSON.stringify(result)}`);
  expect((await answerEnded(core, result.answerId)).event).toBe("finished");
  const { messages } = await core.getConversation(result.conversation.id);
  const answer = messages.find((message) => message.id === result.answerId);
  if (answer?.kind !== "answer") throw new Error("No Answer.");
  return answer;
}

const helpCalls = (calls: readonly ModelCall[]) =>
  calls.filter((call) => call.prompt.includes(HELP));
const right = { cites: [{ marker: 1, quote: PRICE }], text: OWN_TEXT };

describe("Call help on the quick model first", { timeout: 60_000 }, () => {
  test("under an Answers model listed with its quick model, the quick one answers, thinking off, and the User's isn't asked when its quote is found", async () => {
    const { core, meeting, quickCalls, ownCalls, specs } = await setUp(
      { quick: { cites: [{ marker: 1, quote: PRICE }], text: QUICK_TEXT }, own: right },
      { paths: LISTED },
    );

    const answer = await press(core, meeting);

    expect(helpCalls(quickCalls)).toHaveLength(2);
    expect(helpCalls(ownCalls)).toEqual([]);
    expect(specs.filter((spec) => spec.modelId === "claude-haiku-5-5")[0]?.thinking).toBe("off");
    expect(answer.text).toBe(QUICK_TEXT);
    expect(answer.model?.modelId).toBe("claude-haiku-5-5");
    expect(answer.citations).toEqual([
      expect.objectContaining({ marker: 1, quote: PRICE, check: "found" }),
    ]);
  });

  test.each([
    ["a quote that isn't on its page", { cites: [{ marker: 1, quote: WRONG }], text: QUICK_TEXT }],
    ["nothing written", { cites: [], text: "" }],
  ])(
    "a quick reply with %s goes to the User's model, which writes it again from the start",
    async (_, quick) => {
      const { core, meeting, quickCalls, ownCalls } = await setUp(
        { quick, own: right },
        { paths: LISTED },
      );

      const answer = await press(core, meeting);

      expect(helpCalls(quickCalls).length).toBeGreaterThan(0);
      expect(helpCalls(ownCalls)).toHaveLength(2);
      expect(answer.text).toBe(OWN_TEXT);
      expect(answer.model?.modelId).toBe("claude-sonnet-5-5");
      expect(answer.citations).toEqual([
        expect.objectContaining({ marker: 1, quote: PRICE, check: "found" }),
      ]);
    },
  );

  test("what the quick reply recorded is gone once the User's model writes again: a marker it never cites shows no Citation", async () => {
    const { core, meeting, ownCalls } = await setUp(
      {
        quick: {
          cites: [
            { marker: 1, quote: WRONG },
            { marker: 2, quote: SETUP },
          ],
          text: `${QUICK_TEXT}\n\nThe setup fee is $1,500 [^2]\n→ the full price`,
        },
        own: { cites: [{ marker: 1, quote: PRICE }], text: `${OWN_TEXT} [^2]` },
      },
      { paths: LISTED },
    );

    const answer = await press(core, meeting);

    expect(helpCalls(ownCalls)).toHaveLength(2);
    expect(answer.citations).toEqual([
      expect.objectContaining({ marker: 1, quote: PRICE, check: "found" }),
    ]);
    expect(answer.text).not.toContain("[^2]");
  });

  test("with the pair not listed, the User's model answers from the start and the quick one is never asked", async () => {
    const { core, meeting, quickCalls, ownCalls } = await setUp({
      quick: { cites: [{ marker: 1, quote: PRICE }], text: QUICK_TEXT },
      own: right,
    });

    const answer = await press(core, meeting);

    expect(helpCalls(quickCalls)).toEqual([]);
    expect(helpCalls(ownCalls)).toHaveLength(2);
    expect(answer.text).toBe(OWN_TEXT);
  });

  test("a quick-tasks model the User set from another provider never hears the call: the User's model answers", async () => {
    const { core, meeting, quickCalls, ownCalls } = await setUp(
      { quick: { cites: [{ marker: 1, quote: PRICE }], text: QUICK_TEXT }, own: right },
      {
        paths: LISTED,
        before: async (core, providerId) => {
          const other = await core.saveChatProvider({
            kind: "openai",
            modelId: "gpt-6-luna",
            apiKey: "sk-test",
          });
          await core.updateSettings({
            user: {
              chatModel: { providerId, modelId: "claude-sonnet-5-5" },
              quickTasksModel: { providerId: other.id, modelId: "gpt-6-luna" },
            },
          });
        },
      },
    );

    const answer = await press(core, meeting);

    expect(helpCalls(quickCalls)).toEqual([]);
    expect(helpCalls(ownCalls)).toHaveLength(2);
    expect(answer.text).toBe(OWN_TEXT);
  });

  test("an Answers model that is its own quick model sends the same requests, listed or not", async () => {
    const asked = async (paths?: AnswerPathsOverride) => {
      const { core, meeting, ownCalls } = await setUp(
        { quick: right, own: right },
        { answers: "claude-haiku-5-5", ...(paths && { paths }) },
      );
      const answer = await press(core, meeting);
      return { answer, calls: helpCalls(ownCalls) };
    };

    const listed = await asked(LISTED);
    const unlisted = await asked();

    expect(listed.calls).toHaveLength(2);
    expect(listed.calls.map((call) => call.system)).toEqual(
      unlisted.calls.map((call) => call.system),
    );
    expect(listed.calls.map((call) => call.tools)).toEqual(
      unlisted.calls.map((call) => call.tools),
    );
    expect(listed.answer.text).toBe(OWN_TEXT);
  });
});

describe("Call help's reply and its checks", { timeout: 60_000 }, () => {
  test("the reply shows while its Citation is still being checked, and the check lands on the same reply", async () => {
    const { core, meeting } = await setUp({ quick: right, own: right });
    const seen: { text: string; checks: string[]; status: string }[] = [];
    const stop = core.on("conversation.message", (message) => {
      if (message.kind === "answer")
        seen.push({
          text: message.text,
          checks: message.citations.map((citation) => citation.check),
          status: message.status,
        });
    });

    const answer = await press(core, meeting);
    stop();

    const shown = seen.find((each) => each.text.includes("Enterprise has single sign-on"));
    expect(shown).toMatchObject({ status: "streaming" });
    expect(shown?.checks).toEqual(["checking"]);
    expect(answer.citations).toEqual([
      expect.objectContaining({ marker: 1, quote: PRICE, check: "found" }),
    ]);
  });

  const claiming = {
    cites: [{ marker: 1, quote: PRICE }],
    text: "★ I've added Enterprise to your notes: $45 a seat with single sign-on [^1]\n→ answers at once",
  };

  test("a reply that says it changed something isn't checked for it: no model is asked once it is written, and it stands as written", async () => {
    const { core, meeting, checks } = await setUp({ quick: claiming, own: claiming });

    const answer = await press(core, meeting);

    expect(checks).toEqual([]);
    expect(answer.text).toBe(claiming.text);
  });

  test("with the check kept, as before, the same reply is checked once it is written, and every request until then is the same", async () => {
    const kept = await setUp(
      { quick: claiming, own: claiming },
      { paths: { checksHelpClaims: () => true } },
    );
    const skipped = await setUp({ quick: claiming, own: claiming });

    const answers = [
      await press(kept.core, kept.meeting),
      await press(skipped.core, skipped.meeting),
    ];

    expect(kept.checks).toHaveLength(1);
    expect(kept.checks[0]).toContain("I've added Enterprise to your notes");
    expect(skipped.checks).toEqual([]);
    const sent = (calls: readonly ModelCall[]) =>
      helpCalls(calls).map(({ system, prompt, tools }) => ({ system, prompt, tools }));
    expect(sent(kept.ownCalls)).toHaveLength(2);
    expect(sent(kept.ownCalls)).toEqual(sent(skipped.ownCalls));
    expect(answers.map((answer) => answer.text)).toEqual([claiming.text, claiming.text]);
  });
});
