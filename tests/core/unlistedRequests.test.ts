/**
 * A model the lists beside the catalog don't name, and a listed one in a flow they don't admit it
 * to, is sent what main sends it, word for word (#489): every request of a Question, a follow-up
 * that keeps a Citation, an assistant turn, an assistant follow-up, and a Question and a check
 * whose record is fixed before the model writes on; and Claude Haiku 5.5's in a comparison
 * table's cell and a Meeting's notes. Each with its system prompt, messages, Tool definitions and
 * Tool results, against the requests recorded on main: so its Runs also end where main's do. A
 * change meant for every model, a prompt's or a Tool description's, records them again in the
 * same pull request: `npx vitest run tests/core/unlistedRequests.test.ts -u`.
 */
import type { MockLanguageModelV4 } from "ai/test";
import { describe, expect, test, vi } from "vitest";
import type { Core } from "../../src/core";
import { EDIT_INSTRUCTIONS } from "../../src/core/edits/prompt";
import { DRAFT_INSTRUCTIONS } from "../../src/core/skills/draft";
import { askAssistant } from "../helpers/assistant";
import {
  answerEnded,
  askAndFinish,
  setUpWithDocuments,
  shownPassages,
  transcriptCitations,
} from "../helpers/citations";
import { cellModel, compare } from "../helpers/comparisons";
import { createTempDataFolder, startCore } from "../helpers/core";
import { addAndProcess, createSourceFolder, writeSourceFile } from "../helpers/documents";
import { connectToMind } from "../helpers/mindClient";
import { heading, note, question, readMind, writeMind } from "../helpers/minds";
import {
  claimCheckReply,
  type ModelCall,
  type ScriptedReply,
  scriptedModel,
  scriptedModels,
} from "../helpers/models";
import { transcribingCore } from "../helpers/transcription";

const SPRING = "Spring tides happen just after a new moon or a full moon.";
const NEAP = "Neap tides happen at the quarter moons.";
const TIDES = { name: "Tides.md", contents: ["# Tides", "", SPRING, "", NEAP].join("\n") };
const FIRST = "When are spring tides?";
const NEXT = "And when are neap tides?";

/** Searches, cites the line the latest Question asks about, then writes its Answer. */
const tidesModel = () =>
  scriptedModel(
    (call: ModelCall): ScriptedReply => {
      const searched = call.results.find((result) => result.tool === "search_documents");
      if (!searched) return { calls: [{ tool: "search_documents", input: { query: "tides" } }] };
      const neap = call.prompt.includes(NEXT);
      if (!call.results.some((result) => result.tool === "cite")) {
        const quote = neap ? NEAP : SPRING;
        const passage = shownPassages(searched.text).find((each) => each.text.includes(quote));
        return {
          calls: [
            { tool: "cite", input: { citations: [{ marker: 1, passage: passage?.id, quote }] } },
          ],
        };
      }
      return {
        text: neap
          ? "Neap tides come at the quarter moons[^1]."
          : "Spring tides come at new and full moon[^1].",
      };
    },
    { judgesItsAnswers: true },
  );

/**
 * Writes `first` beside a record whose quote the Passage doesn't hold, fixes the record in a call
 * of its own, then writes `then`.
 */
const fixingModel = (first: string, then: string) =>
  scriptedModel(
    (call: ModelCall): ScriptedReply => {
      const searched = call.results.find((result) => result.tool === "search_documents");
      if (!searched) return { calls: [{ tool: "search_documents", input: { query: "tides" } }] };
      const passage = shownPassages(searched.text).find((each) => each.text.includes(SPRING))?.id;
      const cite = (quote: string) => ({
        tool: "cite",
        input: { citations: [{ marker: 1, passage, quote }] },
      });
      const cites = call.results.filter((result) => result.tool === "cite").length;
      if (cites === 0) return { text: first, calls: [cite("Spring tides happen every week.")] };
      return cites === 1 ? { calls: [cite(SPRING)] } : { text: then };
    },
    { judgesItsAnswers: true },
  );

/** Claude Haiku 5.5, saved as the User saves it, its service allowed. */
async function withHaiku(core: Core) {
  core.on("consent.requested", (asked) => void core.respondToConsent(asked.requestId, true));
  const saved = await core.saveChatProvider({
    kind: "anthropic",
    apiKey: "sk-test",
    modelId: "claude-haiku-5-5",
  });
  if (saved.service) await core.allowDataFlow("chat", saved.service.id);
}

/** One cell of a comparison table, filled by Claude Haiku 5.5: every request it made. */
async function cellFilled() {
  const model = cellModel();
  const core = startCore(await createTempDataFolder(), {
    createChatModel: scriptedModels(model).createChatModel,
  });
  await withHaiku(core);
  const sources = await createSourceFolder();
  const [corvane] = await addAndProcess(core, [
    await writeSourceFile(
      sources,
      "Corvane.txt",
      "Corvane Agreement.\nTermination notice: 90 days.",
    ),
  ]);
  if (!corvane) throw new Error("The Document wasn't added.");
  const mind = await core.createMind({ title: "Shortlist" });
  const client = await connectToMind(core, mind.id);
  await compare(core, client, {
    mindId: mind.id,
    documentIds: [corvane.id],
    questions: ["Termination notice"],
  });
  core.close();
  return requests(model);
}

const PRICE = "We agreed the enterprise price is 45 dollars a seat";

/** A Meeting's notes, one line under one heading, filled in by Claude Haiku 5.5 after Stop: every request it made. */
async function notesFilled() {
  const model = scriptedModel(
    (call): ScriptedReply => {
      if (!call.prompt.includes("Fill them in from the transcript")) return { text: "OK" };
      const transcript = /<live-transcript>\n([\s\S]*?)\n<\/live-transcript>/.exec(call.prompt);
      const citations = transcriptCitations(call, shownPassages(transcript?.[1] ?? ""), {
        1: PRICE,
      });
      if (citations) return citations;
      return { text: "### L1\nThe enterprise price is 45 dollars a seat [^1]." };
    },
    { judgesItsAnswers: true },
  );
  const { core, record } = await transcribingCore(await createTempDataFolder(), {
    model,
    engine: {
      lines: [PRICE, "Dana will send the contract by Friday"],
      theirLines: ["The budget is approved for this year"],
    },
  });
  await withHaiku(core);
  const meeting = await core.createMeeting();
  const client = await connectToMind(core, meeting.mindId);
  writeMind(client, [heading(2, "Pricing"), note("price")]);
  await client.settled();
  await core.startMeeting({ meetingId: meeting.id, systemAudio: true });
  record(12_000);
  const now = async () => (await core.listMeetings()).find((each) => each.id === meeting.id);
  await vi.waitFor(async () => expect((await now())?.transcript?.lines ?? 0).toBeGreaterThan(2));
  await core.stopMeeting(meeting.id);
  await vi.waitFor(async () => expect((await now())?.fill?.state).toBe("filled"), {
    timeout: 20_000,
  });
  core.close();
  return requests(model);
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

/** The requests from the `from`th on, without what changes from run to run: ids, hashes and file dates. */
const requests = (model: MockLanguageModelV4, from = 0) =>
  model.doStreamCalls
    .slice(from)
    .map(({ prompt, tools, toolChoice, temperature, providerOptions }) => ({
      prompt,
      tools,
      toolChoice,
      temperature,
      providerOptions,
    }));

/**
 * What the interface calls a Note was once a Mind in what the model reads (#2312); the Chinese
 * text wrote it in Latin letters too, as in “已在新的 Mind 中整理好总结”.
 */
const OLD_WORDS = ["Mind", "Minds"] as const;

/** Each old word a text says as a word of its own, with the words round it: “IncarnaMind” and create_mind say none. */
const oldWordsIn = (text: string): string[] =>
  OLD_WORDS.flatMap((word) =>
    [...text.matchAll(new RegExp(`\\b${word}\\b`, "g"))].map(
      ({ index = 0 }) => `…${text.slice(Math.max(0, index - 40), index + word.length + 40)}…`,
    ),
  );

/** What a model reads of a request: its system prompt and messages, its Tools, the schema its reply follows, and its provider's options. */
const READ_PARTS = ["prompt", "tools", "responseFormat", "providerOptions"];

/** Every string in a value, decoded, with where it sits: "generate 0 › prompt › 0 › content". */
function stringsIn(value: unknown, place: string): { place: string; text: string }[] {
  if (typeof value === "string") return [{ place, text: value }];
  if (Array.isArray(value)) {
    return value.flatMap((each, index) => stringsIn(each, `${place} › ${index}`));
  }
  if (value !== null && typeof value === "object") {
    return Object.entries(value).flatMap(([key, each]) => stringsIn(each, `${place} › ${key}`));
  }
  return [];
}

interface Sent {
  doStreamCalls: readonly object[];
  doGenerateCalls: readonly object[];
}

/** Every string a model was sent, streamed or not, by the request and the part it sits in. */
const stringsSent = (model: Sent) =>
  [
    ...model.doStreamCalls.map((call, index) => ({ call, name: `stream ${index}` })),
    ...model.doGenerateCalls.map((call, index) => ({ call, name: `generate ${index}` })),
  ].flatMap(({ call, name }) =>
    Object.entries(call)
      .filter(([part]) => READ_PARTS.includes(part))
      .flatMap(([part, value]) => stringsIn(value, `${name} › ${part}`)),
  );

/** Each old word a model was sent, as "where it sits: …the words round it…". */
const oldWordsSent = (model: Sent) =>
  stringsSent(model).flatMap(({ place, text }) =>
    oldWordsIn(text).map((said) => `${place}: ${said}`),
  );

const ASKED = {
  en: {
    first: FIRST,
    fix: "Fix the typos in this",
    add: "add a summary",
    claiming: "I've added the summary to the note.",
    denied: "I didn't add it.",
  },
  "zh-CN": {
    first: "大潮什么时候来？",
    fix: "改掉这里的错别字",
    add: "加一段总结",
    claiming: "我已经把总结加到笔记里了。",
    denied: "我没有加。",
  },
} as const;

const normalised = (value: unknown) =>
  `${JSON.stringify(value, null, 1)
    .replace(UUID, "<id>")
    .replace(/("promptCacheKey": )"[0-9a-f]+"/g, '$1"<hash>"')
    .replace(/(file-(?:created|modified)=\\")\d{4}-\d{2}-\d{2}/g, "$1<date>")}\n`;

describe("A model no list names, or one in a flow no list admits it to", {
  timeout: 60_000,
}, () => {
  test("is sent main's requests, word for word, for Questions, follow-ups, fixes and checks, as is Claude Haiku 5.5 for a cell and a Meeting's notes", async () => {
    const asked = tidesModel();
    const inMind = await setUpWithDocuments(asked, [TIDES]);
    await askAndFinish(inMind.core, inMind.client, inMind.mind.id, FIRST);

    const followed = tidesModel();
    const again = await setUpWithDocuments(followed, [TIDES]);
    await askAndFinish(again.core, again.client, again.mind.id, FIRST);
    const before = followed.doStreamCalls.length;
    const next = question(NEXT);
    writeMind(again.client, [...(readMind(again.client).toJSON().content ?? []), next]);
    await again.client.settled();
    const result = await again.core.askQuestion({
      mindId: again.mind.id,
      questionId: next.attrs.id,
    });
    if (!result.asked) throw new Error("The follow-up wasn't asked.");
    expect((await answerEnded(again.core, result.answerId)).event).toBe("finished");

    const inAssistant = tidesModel();
    const panel = await setUpWithDocuments(inAssistant, [TIDES]);
    const first = await panel.core.askInConversation({ text: FIRST, mindId: panel.mind.id });
    if (!first.asked) throw new Error("The Question wasn't asked.");
    await answerEnded(panel.core, first.answerId);
    const turn = inAssistant.doStreamCalls.length;
    await askAssistant(panel.core, {
      text: NEXT,
      mindId: panel.mind.id,
      conversationId: first.conversation.id,
    });

    const fixed = fixingModel(
      "Spring tides come at new and full moon[^1].",
      "Neap tides come at the quarter moons.",
    );
    const fixing = await setUpWithDocuments(fixed, [TIDES]);
    await askAndFinish(fixing.core, fixing.client, fixing.mind.id, FIRST);

    const checked = fixingModel(
      "Tides says spring tides follow new and full moons [^1].",
      "Verdict: supported\nAbsence: no",
    );
    const checking = await setUpWithDocuments(checked, [TIDES]);
    expect(
      await checking.core.checkClaim({ claim: "Spring tides come at new and full moon." }),
    ).toMatchObject({ verdict: "supported" });

    await expect(
      normalised({
        question: requests(asked),
        followUp: requests(followed, before),
        assistant: requests(inAssistant).slice(0, turn),
        assistantFollowUp: requests(inAssistant, turn),
        fixedThenWritten: requests(fixed),
        checkFixedThenVerdict: requests(checked),
        haikuComparisonCell: await cellFilled(),
        haikuMeetingNotes: await notesFilled(),
      }),
    ).toMatchFileSnapshot("../fixtures/answers/unlisted-requests.json.snap");
  });

  test("the scan finds an old word anywhere a model reads it, a line's first word too, and says where", () => {
    const sent = {
      doStreamCalls: [
        {
          prompt: [{ role: "system", content: "Examples:\nMind here means a Note." }],
          tools: [
            { type: "function", name: "create_mind", description: "Makes a Note.\n\tMinds too." },
          ],
        },
      ],
      doGenerateCalls: [
        {
          prompt: [{ role: "system", content: "IncarnaMind calls create_mind for a Note." }],
          responseFormat: {
            type: "json",
            schema: { properties: { about: { description: "Mind when it is one" } } },
          },
        },
      ],
    };

    expect(oldWordsSent(sent)).toEqual([
      "stream 0 › prompt › 0 › content: …Examples:\nMind here means a Note.…",
      "stream 0 › tools › 0 › description: …Makes a Note.\n\tMinds too.…",
      "generate 0 › responseFormat › schema › properties › about › description: …Mind when it is one…",
    ]);
  });

  test.each(["en", "zh-CN"] as const)(
    "every request of an assistant turn, its Tools, a rewrite and the claim check that asks again says Note, never Mind (%s)",
    async (language) => {
      const asked = ASKED[language];
      const model = tidesModel();
      const panel = await setUpWithDocuments(model, [TIDES]);
      await panel.core.updateSettings({ user: { language } });
      const first = await panel.core.askInConversation({
        text: asked.first,
        mindId: panel.mind.id,
      });
      if (!first.asked) throw new Error("The Question wasn't asked.");
      expect((await answerEnded(panel.core, first.answerId)).event).toBe("finished");

      const retried = scriptedModel(
        (call: ModelCall): ScriptedReply => {
          const passage =
            call.system === EDIT_INSTRUCTIONS
              ? /<passage>\n([\s\S]*?)\n<\/passage>/.exec(call.prompt)?.[1]
              : undefined;
          if (passage !== undefined) return { text: passage.replace("visted", "visited") };
          if (!call.results.some((result) => result.tool === "edit_mind")) {
            return { calls: [{ tool: "edit_mind", input: { instruction: "Fix the typos" } }] };
          }
          return call.prompt.includes("your edits left")
            ? { text: "Fixed “compleatly”." }
            : { text: "Fixed “visted” and “compleatly”." };
        },
        { judgesItsAnswers: true },
      );
      const fixing = await setUpWithDocuments(retried, [TIDES]);
      await fixing.core.updateSettings({ user: { language } });
      writeMind(fixing.client, [
        heading(2, "Trip notes"),
        note("We visted the harbour, and the tide went out compleatly."),
      ]);
      await fixing.client.settled();
      const turn = await fixing.core.askInConversation({
        text: asked.fix,
        mindId: fixing.mind.id,
      });
      if (!turn.asked) throw new Error("The Question wasn't asked.");
      expect((await answerEnded(fixing.core, turn.answerId)).event).toBe("finished");

      // Every kind the judge can return, so each phrase of the note it is asked again by is checked.
      const kinds = ["made", "added", "changed", "removed"] as const;
      const reasked = scriptedModel(
        (call: ModelCall): ScriptedReply => ({
          text: call.prompt.includes("but no Tool did that") ? asked.denied : asked.claiming,
        }),
        {
          judgesItsAnswers: true,
          generate: (call) =>
            claimCheckReply(
              call,
              kinds.map((kind) => ({ sentence: asked.claiming, kind })),
            ),
        },
      );
      const asking = await setUpWithDocuments(reasked, [TIDES]);
      await asking.core.updateSettings({ user: { language } });
      const claimed = await asking.core.askInConversation({
        text: asked.add,
        mindId: asking.mind.id,
      });
      if (!claimed.asked) throw new Error("The Question wasn't asked.");
      expect((await answerEnded(asking.core, claimed.answerId)).event).toBe("finished");
      const read = await asking.core.getConversation(claimed.conversation.id);
      const reply = read.messages.find((message) => message.id === claimed.answerId);
      expect(reply?.kind === "answer" && reply.text).toBe(asked.denied);

      for (const each of [model, retried, reasked]) expect(oldWordsSent(each)).toEqual([]);
      expect(oldWordsIn(DRAFT_INSTRUCTIONS)).toEqual([]);
      // The scan above can't pass with the claim check's request, or the schema of its verdict, left out.
      const checked = stringsSent({ doStreamCalls: [], doGenerateCalls: reasked.doGenerateCalls });
      expect(checked.some(({ text }) => text.includes("For each claim that a Note was made"))).toBe(
        true,
      );
      expect(checked.some(({ place }) => place.includes(" › responseFormat › "))).toBe(true);
      // The request that asks again must carry every phrase, so a judge that names nothing can't pass.
      const again = requests(reasked).find((request) =>
        JSON.stringify(request).includes("but no Tool did that"),
      );
      expect(again).toBeDefined();
      const said = JSON.stringify(again);
      for (const phrase of [
        "made a Note",
        "added text to a Note",
        "changed a Note",
        "removed or replaced text in a Note",
      ]) {
        expect(said, phrase).toContain(phrase);
      }
    },
  );
});
