/**
 * A call-help press answered in one reply, its Citation records first (#3354), for a model the list
 * beside the catalog admits: through the core's public interface, as the floating panel presses a
 * button. A reply that says the Passages it holds don't answer goes on to the Tool loop.
 */
import { describe, expect, test } from "vitest";
import type { Core, Meeting } from "../../src/core";
import { answerEnded, shownPassages } from "../helpers/citations";
import { createTempDataFolder } from "../helpers/core";
import { createSourceFolder, waitForProcessing, writeSourceFile } from "../helpers/documents";
import { type ModelCall, scriptedModel, scriptedModels } from "../helpers/models";
import { transcribingCore, until } from "../helpers/transcription";

const PRICE = "Enterprise plan: $45 per seat a month, single sign-on included.";
const OPTIONS = "★ Yes, Enterprise is $45 a seat [^1]\n→ answers at once";

const block = (text: string, tag: string) =>
  new RegExp(`<${tag}>\\n([\\s\\S]*?)\\n</${tag}>`).exec(text)?.[1] ?? null;

/**
 * Answers as the loop does (`cite`, then the reply), and in one reply as `oneReply` says: its
 * records of the first Passage found ahead, or, given none, a word to search for instead.
 */
function answering(calls: ModelCall[], oneReply: "answers" | "asks for more") {
  return scriptedModel(
    (call) => {
      calls.push(call);
      const [found] = shownPassages(block(call.prompt, "found-in-documents") ?? "");
      if (call.json) {
        return {
          text: JSON.stringify(
            oneReply === "answers" && found
              ? {
                  citations: [{ marker: 1, passage: found.id, quote: PRICE }],
                  answer: OPTIONS,
                  more: "",
                }
              : { citations: [], answer: "", more: "Enterprise price per seat" },
          ),
        };
      }
      const searched = call.results.find((result) => result.tool === "search_documents");
      const [passage] = shownPassages(searched?.text ?? "");
      if (passage && !call.results.some((result) => result.tool === "cite")) {
        return {
          calls: [
            {
              tool: "cite",
              input: { citations: [{ marker: 1, passage: passage.id, quote: PRICE }] },
            },
          ],
        };
      }
      if (!searched) {
        return { calls: [{ tool: "search_documents", input: { query: "Enterprise price" } }] };
      }
      return { text: OPTIONS };
    },
    { judgesItsAnswers: true },
  );
}

async function setUp(admitted: boolean, oneReply: "answers" | "asks for more", withPrices = true) {
  const calls: ModelCall[] = [];
  const dataDir = await createTempDataFolder();
  const models = scriptedModels(answering(calls, oneReply));
  const { core, record } = await transcribingCore(dataDir, {
    createChatModel: models.createChatModel,
    engine: { theirLines: ["How much is Enterprise per seat?"] },
    answerPaths: { answersInOneReply: () => admitted },
  });
  await core.saveChatProvider({ kind: "ollama", modelId: "local-model" });
  if (withPrices) {
    const sources = await createSourceFolder();
    const added = await core.addDocuments([
      await writeSourceFile(
        sources,
        "Price sheet.txt",
        `Price sheet 2026\n\nTeam plan: $25 per seat a month.\n${PRICE}`,
      ),
    ]);
    await waitForProcessing(
      core,
      added.documents.map((document) => document.id),
    );
  }
  const meeting = await core.createMeeting();
  await core.startMeeting({ meetingId: meeting.id, systemAudio: true });
  record(9_000);
  await until(core, meeting.id, (transcript) => transcript.lines >= 2);
  return { core, meeting, calls };
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

const BOTH_PRICES = "Team plan: $25 per seat a month; Enterprise plan: $45 per seat a month.";

/**
 * Answers in one reply with how much more Enterprise costs a seat than Team, the difference worked
 * out by the app from the price sheet's two prices.
 */
function differenceOfPrices(calls: ModelCall[]) {
  return scriptedModel(
    (call) => {
      calls.push(call);
      const [found] = shownPassages(block(call.prompt, "found-in-documents") ?? "");
      if (!call.json || !found) return { text: "" };
      return {
        text: JSON.stringify({
          citations: [{ marker: 1, passage: found.id, quote: BOTH_PRICES }],
          calculations: [
            {
              marker: 1,
              label: "Enterprise over Team, per seat a month",
              formula: "enterprise - team",
              shown: "$20",
              inputs: [
                { name: "enterprise", label: "Enterprise per seat", citation: 1, value: 45 },
                { name: "team", label: "Team per seat", citation: 1, value: 25 },
              ],
            },
          ],
          answer: "★ Enterprise is [=1] more a seat than Team [^1]\n→ answers at once",
          more: "",
        }),
      };
    },
    { judgesItsAnswers: true },
  );
}

/** What the other side says in a call long enough that its Transcript is in several Passages. */
const LONG_CALL = Array.from(
  { length: 16 },
  (_, index) =>
    `Point ${index + 1} from our side: the dispatch team reviews every route change with the warehouse leads, the drivers get the new sheets the evening before, and nobody changes a route on the day without a call to the depot first.`,
);
const AUDIT = "We need the pilot live before our audit in June.";

/** Words said in every line of `LONG_CALL`: at many moments of the call. */
const SAID_OFTEN = "the drivers get the new sheets the evening before";

/**
 * Sums the call up in one reply, citing `quote` to the first Passage of the Transcript, which
 * doesn't hold its last line, at `location` if given, as a model that can't be told so may.
 */
function citesTheFirstPassage(calls: ModelCall[], quote = AUDIT, location?: string) {
  return scriptedModel(
    (call) => {
      calls.push(call);
      const [first] = shownPassages(block(call.prompt, "live-transcript") ?? "");
      if (!call.json || !first) return { text: "" };
      return {
        text: JSON.stringify({
          citations: [{ marker: 1, passage: first.id, quote, ...(location && { location }) }],
          answer: "- They need the pilot live before their June audit [^1]",
          more: "",
        }),
      };
    },
    { judgesItsAnswers: true },
  );
}

/** The long call heard, Sum up pressed: its reply and the requests made. */
async function summedUp(model: (calls: ModelCall[]) => ReturnType<typeof scriptedModel>) {
  const calls: ModelCall[] = [];
  const dataDir = await createTempDataFolder();
  const models = scriptedModels(model(calls));
  const { core, record } = await transcribingCore(dataDir, {
    createChatModel: models.createChatModel,
    engine: { lines: [], theirLines: [...LONG_CALL, AUDIT] },
    answerPaths: { answersInOneReply: () => true },
  });
  await core.saveChatProvider({ kind: "ollama", modelId: "local-model" });
  const meeting = await core.createMeeting();
  await core.startMeeting({ meetingId: meeting.id, systemAudio: true });
  record(60_000);
  await until(core, meeting.id, (transcript) => transcript.lines >= LONG_CALL.length + 1);
  const result = await core.askMeetingHelp({ meetingId: meeting.id, kind: "sum" });
  if (!result.asked) throw new Error(`Not asked: ${JSON.stringify(result)}`);
  await answerEnded(core, result.answerId);
  const { messages } = await core.getConversation(result.conversation.id);
  const answer = messages.find((message) => message.id === result.answerId);
  if (answer?.kind !== "answer") throw new Error("No Answer.");
  return { answer, calls };
}

/** The requests that wrote the reply: not a judge's. */
const writing = (calls: ModelCall[]) => calls.filter((call) => call.question === undefined);

describe("A call-help press in one reply (#3354)", { timeout: 60_000 }, () => {
  // protects=a press on an admitted model is one request whose instructions ask for the records before the reply, and the panel shows the reply with its Citation found in the price sheet; fails_when=the press still runs the loop's two requests, the records come after the reply, or the Citation isn't found; no_claim=which models are admitted, which eval/speed's gate decides.
  test("on an admitted model, one request: its records first, then the reply, cited to the price sheet", async () => {
    const { core, meeting, calls } = await setUp(true, "answers");

    const answer = await press(core, meeting);

    expect(writing(calls)).toHaveLength(1);
    expect(writing(calls)[0]?.json).toBe(true);
    expect(writing(calls)[0]?.system).toContain(
      'Reply with one JSON object, its fields in this order: {"citations"',
    );
    expect(answer.text).toBe(OPTIONS);
    expect(answer.citations).toEqual([
      expect.objectContaining({ documentName: "Price sheet", quote: PRICE, check: "found" }),
    ]);
  });

  // protects=a one-reply answer can't be told it named the wrong Passage, so a quote another Passage of the same Transcript holds is cited where it was said and its Citation is found; fails_when=the Citation stays not found; no_claim=a quote another Document holds, which stays as named.
  test("a call's line the reply cites to the wrong Passage of its Transcript is found where it was said", async () => {
    const { answer, calls } = await summedUp((calls) => citesTheFirstPassage(calls));

    const transcript = shownPassages(
      block(writing(calls)[0]?.prompt ?? "", "live-transcript") ?? "",
    );
    expect(transcript.length).toBeGreaterThan(1);
    expect(transcript[0]?.text).not.toContain(AUDIT);
    expect(answer.citations).toEqual([expect.objectContaining({ quote: AUDIT, check: "found" })]);
  });

  // protects=a one-reply answer can't be told its time is wrong, so a line said once, cited at a time nothing was said, is found where it was said; fails_when=it stays not found; no_claim=a time that holds the words, which is kept as named.
  test("a line said once, cited at a time nothing was said, is found where it was said", async () => {
    const { answer } = await summedUp((calls) => citesTheFirstPassage(calls, AUDIT, "9:00"));

    expect(answer.citations).toEqual([expect.objectContaining({ quote: AUDIT, check: "found" })]);
  });

  // protects=words said at several moments, cited at a time nothing was said, are never shown as found at one of them (#2306); fails_when=a found Citation of them appears; no_claim=whether the record is dropped or kept not found, which is as before.
  test("words said at many moments, cited at a time nothing was said, are never found at one of them", async () => {
    const { answer } = await summedUp((calls) => citesTheFirstPassage(calls, SAID_OFTEN, "9:00"));

    expect(answer.citations.filter((citation) => citation.check === "found")).toEqual([]);
  });

  // protects=on a model offered calculate (ADR-0021), a one-reply answer is asked for its calculations in its JSON and the app works its figure out from the cited numbers, as the loop's calculate does; fails_when=the one-reply form tells it there is no calculator, or the figure isn't worked out; no_claim=how often a model gives calculations.
  test("on a model offered calculate, the one reply gives its calculations and the app works the figure out", async () => {
    const calls: ModelCall[] = [];
    const dataDir = await createTempDataFolder();
    const models = scriptedModels(differenceOfPrices(calls));
    const { core, record } = await transcribingCore(dataDir, {
      createChatModel: models.createChatModel,
      engine: { theirLines: ["How much more is Enterprise than Team per seat?"] },
      answerPaths: { answersInOneReply: () => true },
    });
    const saved = await core.saveChatProvider({
      kind: "anthropic",
      apiKey: "sk-test",
      modelId: "claude-haiku-5-5",
    });
    if (saved.service) await core.allowDataFlow("chat", saved.service.id);
    const sources = await createSourceFolder();
    const added = await core.addDocuments([
      await writeSourceFile(sources, "Price sheet.txt", `Price sheet 2026\n\n${BOTH_PRICES}`),
    ]);
    await waitForProcessing(
      core,
      added.documents.map((document) => document.id),
    );
    const meeting = await core.createMeeting();
    await core.startMeeting({ meetingId: meeting.id, systemAudio: true });
    record(9_000);
    await until(core, meeting.id, (transcript) => transcript.lines >= 1);

    const answer = await press(core, meeting);

    expect(writing(calls)).toHaveLength(1);
    expect(writing(calls)[0]?.system).toContain("- calculations: one for each number");
    expect(writing(calls)[0]?.system).not.toContain("IncarnaMind has no calculation Tool");
    expect(answer.figures).toEqual([
      expect.objectContaining({ marker: 1, shown: expect.stringContaining("20") }),
    ]);
  });

  // protects=a one-reply answer that says the Passages it holds don't answer is never shown: the press goes on to the Tool loop, which searches and cites, and nothing of the first reply is left in the panel; fails_when=the press ends empty or shows the JSON, or the loop isn't asked; no_claim=how often a model asks for more.
  test("a reply that asks for more of the Documents goes on to the loop, which searches and cites, and nothing of it shows", async () => {
    const { core, meeting, calls } = await setUp(true, "asks for more", false);

    const answer = await press(core, meeting);

    const [first, ...loop] = writing(calls);
    expect(first?.json).toBe(true);
    expect(loop.length).toBeGreaterThan(0);
    expect(loop[0]?.json).toBe(false);
    expect(loop[0]?.tools).toContain("search_documents");
    expect(answer.text).toBe(OPTIONS);
    expect(answer.text).not.toContain("more");
  });

  // protects=a model the list doesn't admit (every model, by default) presses as before: the Tool loop, records with `cite`, the reply after; fails_when=a press on a model not admitted is asked for one reply; no_claim=the loop's own steps, which meetingHelp.test.ts covers.
  test("on a model not admitted, the press runs the Tool loop as before, cited to the price sheet", async () => {
    const { core, meeting, calls } = await setUp(false, "answers");

    const answer = await press(core, meeting);

    expect(writing(calls).every((call) => !call.json)).toBe(true);
    expect(writing(calls)[0]?.tools).toContain("cite");
    expect(answer.citations).toEqual([
      expect.objectContaining({ documentName: "Price sheet", quote: PRICE, check: "found" }),
    ]);
  });
});
