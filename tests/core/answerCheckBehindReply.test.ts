/**
 * A Question asked while an earlier Answer's sentences are being checked (#2944): the check sends
 * no new request until the reply's stream ends, and then every verdict lands. The model is
 * scripted; its replies wait for the test.
 */
import { expect, test } from "vitest";
import type { CoreEvents } from "../../src/core";
import { answerJudged, shownPassages } from "../helpers/citations";
import { createTempDataFolder, startCore } from "../helpers/core";
import { addAndProcess, writeSourceFile } from "../helpers/documents";
import { type GenerateCall, scriptedModel, unscripted } from "../helpers/models";

const lineOf = (n: number) => `Kiln ${n} is due in 2027`;
const SENTENCES = 56;
const LINES = Array.from({ length: SENTENCES }, (_, index) => lineOf(index + 1));

/** Lets what can go on without waiting for the test go on. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 150));

/** A promise the test settles by hand. */
function gate() {
  let open: () => void = () => undefined;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { opened, open };
}

// protects=the check of an Answer's sentences sends no new request while the next Question's reply is being written on its key, and every verdict lands once that reply's stream ends (#2944: the check sends no new request until the reply's stream ends, then every verdict lands); fails_when=a batch is sent beside the reply, or a verdict is lost by the wait; no_claim=how long a reply takes.
test("a Question asked while an Answer's sentences are checked holds the check's next batch until its reply ends", async () => {
  const batches: GenerateCall[] = [];
  /** The claims checks, one for each reply the app checks for what it says it did: part of the reply itself. */
  const claims: string[] = [];
  const firstBatches = gate();
  const secondReply = gate();
  const secondReplyBegan = gate();
  const model = scriptedModel(
    (call) => {
      if (call.prompt.includes("Second question")) {
        return {
          text: "That is later.",
          pause: { after: 0, until: secondReply.opened, reached: secondReplyBegan.open },
        };
      }
      const searches = call.results.filter((result) => result.tool === "search_documents");
      if (searches.length === 0) {
        return {
          calls: [{ tool: "search_documents", input: { query: "kiln installed February" } }],
        };
      }
      if (!call.results.some((result) => result.tool === "cite")) {
        const passages = searches.flatMap((search) => shownPassages(search.text));
        const citations = LINES.map((quote, index) => ({
          marker: index + 1,
          passage: passages.find((each) => each.text.includes(quote))?.id,
          quote,
        }));
        return { calls: [{ tool: "cite", input: { citations } }] };
      }
      return { text: LINES.map((line, index) => `${line}[^${index + 1}].`).join("\n\n") };
    },
    {
      generate: (call) => {
        if (call.question === "claimed-changes") {
          claims.push(call.prompt);
          return { text: '{"claims":[]}' };
        }
        if (call.question === "request-done") {
          return { text: '{"asks_change":"no","request":"none"}' };
        }
        if (call.question !== "sentence-batch") return unscripted(call.question, call.system);
        batches.push(call);
        const count = [...call.prompt.matchAll(/<sentence number="\d+">/g)].length;
        const sentences = Array.from({ length: count }, (_, index) => ({
          number: index + 1,
          kind: "fact",
          verdict: "supported",
          roles: "same",
          time: "same",
          quoted: "states",
          says: "The schedule says so.",
        }));
        // Six batches go out at once; the seventh waits for a place, and is the one held.
        return {
          text: JSON.stringify({ sentences }),
          ...(batches.length <= 6 && { until: firstBatches.opened }),
        };
      },
    },
  );
  const core = startCore(await createTempDataFolder(), { createChatModel: () => model });
  core.on("consent.requested", (asked) => void core.respondToConsent(asked.requestId, true));
  const saved = await core.saveChatProvider({
    kind: "anthropic",
    apiKey: "sk-ant-test",
    modelId: "claude-haiku-5-5",
  });
  if (saved.service) await core.allowDataFlow("chat", saved.service.id);
  const sources = await createTempDataFolder();
  await addAndProcess(core, [
    await writeSourceFile(
      sources,
      "Kiln schedule.md",
      `# Kiln schedule\n\n${LINES.map((line) => `${line}.`).join("\n\n")}\n`,
    ),
  ]);

  const finished = new Promise<CoreEvents["answer.finished"]>((resolve) => {
    const stop = core.on("answer.finished", (event) => {
      stop();
      resolve(event);
    });
  });
  const first = await core.askInConversation({ text: "When are the kilns installed?" });
  if (!first.asked) throw new Error("Not asked.");
  await finished;
  for (let turn = 0; turn < 50 && batches.length < 6; turn++) await settle();
  expect(batches).toHaveLength(6);

  // The next Question's reply begins, and stays out.
  const second = await core.askInConversation({
    conversationId: first.conversation.id,
    text: "Second question: anything else?",
  });
  if (!second.asked) throw new Error("Not asked.");
  await secondReplyBegan.opened;

  // The six batches out finish; the seventh is not sent beside the reply.
  firstBatches.open();
  await settle();
  await settle();
  expect(batches).toHaveLength(6);

  secondReply.open();
  const answer = await answerJudged(core, first.conversation.id, first.answerId);

  expect(batches).toHaveLength(7);
  // A check inside its own reply's turn is the reply's own, and never waits for that turn: each
  // of the two replies had its claims checked, the second's while it was still out.
  expect(claims).toHaveLength(2);
  expect(answer.citations.map((citation) => citation.check)).toEqual(
    Array(SENTENCES).fill("found"),
  );
}, 60_000);
