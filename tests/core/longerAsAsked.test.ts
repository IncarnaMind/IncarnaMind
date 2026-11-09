import type { MockLanguageModelV4 } from "ai/test";
import { describe, expect, test } from "vitest";
import { EDIT_INSTRUCTIONS, EDIT_INSTRUCTIONS_NAMED } from "../../src/core/edits/prompt";
import { askAssistant, changesIn, lastResult, mindCalls } from "../helpers/assistant";
import { checkReply, isCheckRun } from "../helpers/checks";
import { shownPassages } from "../helpers/citations";
import { createTempDataFolder, startCore } from "../helpers/core";
import { createSourceFolder, waitForProcessing, writeSourceFile } from "../helpers/documents";
import { connectToMind } from "../helpers/mindClient";
import { heading, note, shownWithChanges, writeMind } from "../helpers/minds";
import {
  judgesNothing,
  type ModelCall,
  type ScriptedReply,
  scriptedModel,
  scriptedModels,
} from "../helpers/models";

/**
 * "Longer" over the assistant's own cited text (#1385), through the core as the assistant asks:
 * new text off the length the User asked for is refused once with the sizes to write it at, a
 * sentence it adds with no Citation is refused once by name, and the result tells the model the
 * multiple measured from the text, in words or Chinese characters, so its reply never works one
 * out. The model's choices are scripted; real models' are in tests/live/assistantLonger.live.test.ts.
 */

const LEASES = {
  English: {
    file: "Lease.md",
    contents:
      "# Lease\n\nRent is due on the first of each month. The deposit is two months of rent. The tenant pays for water and power. Pets need the landlord's written consent.",
    quotes: [
      "Rent is due on the first of each month.",
      "The deposit is two months of rent.",
      "The tenant pays for water and power.",
      "Pets need the landlord's written consent.",
    ],
    first:
      "## Summary\n\nRent is due on the first of each month [^1]. The deposit is two months of rent [^2].",
    query: "rent deposit",
  },
  Chinese: {
    file: "租约.md",
    contents:
      "# 租约\n\n房租在每月一日支付。押金为两个月的房租。租客自付水电费。养宠物须经房东书面同意。",
    quotes: [
      "房租在每月一日支付。",
      "押金为两个月的房租。",
      "租客自付水电费。",
      "养宠物须经房东书面同意。",
    ],
    first: "## 摘要\n\n房租在每月一日支付[^1]。押金为两个月的房租[^2]。",
    query: "房租 押金",
  },
} as const;

type Language = keyof typeof LEASES;

/** A Folder with the lease, and an empty Note in front, on a scripted model. */
async function setUp(model: MockLanguageModelV4, language: Language) {
  const core = startCore(await createTempDataFolder(), {
    createChatModel: scriptedModels(model).createChatModel,
  });
  await core.saveChatProvider({ kind: "ollama", modelId: "local-model" });
  const folder = await core.createLibraryGroup({ name: "Flat", description: "" });
  const sources = await createSourceFolder();
  const lease = LEASES[language];
  const added = await core.addDocuments(
    [await writeSourceFile(sources, lease.file, lease.contents)],
    {
      groupId: folder.id,
    },
  );
  await waitForProcessing(
    core,
    added.documents.map((document) => document.id),
  );
  const mind = await core.createMind({ title: "Flat notes", folderId: folder.id });
  return { core, mind, scope: { folderIds: [folder.id], tagIds: [], documentIds: [] } };
}

const lastAsked = ({ options }: ModelCall): string => {
  const last = options.prompt.filter((message) => message.role === "user").at(-1);
  if (!last) return "";
  return typeof last.content === "string"
    ? last.content
    : last.content.map((part) => ("text" in part ? part.text : "")).join("");
};

/**
 * A model that writes the lease's summary into the Note, then, asked for it longer, searches,
 * cites every sentence of the lease and gives edit_mind each of `longer` in turn as the new text.
 */
function summaryModel(
  language: Language,
  longer: readonly { content: string; times?: number }[],
  reply = "Done.",
) {
  const lease = LEASES[language];
  let tries = 0;
  return scriptedModel(
    (call: ModelCall): ScriptedReply => {
      if (isCheckRun(call)) return checkReply(call, {});
      const { results } = call;
      const search = results.find((result) => result.tool === "search_documents");
      if (!search) return { calls: [{ tool: "search_documents", input: { query: lease.query } }] };
      const [passage] = shownPassages(search.text);
      const cite = {
        tool: "cite",
        input: {
          citations: lease.quotes.map((quote, index) => ({
            marker: index + 1,
            passage: passage?.id,
            quote,
          })),
        },
      };
      if (lastAsked(call).includes("Write a summary of the lease")) {
        if (results.some((result) => result.tool === "add_to_mind")) return { text: "Wrote it." };
        return { calls: [cite, { tool: "add_to_mind", input: { content: lease.first } }] };
      }
      const edits = results.filter((result) => result.tool === "edit_mind");
      const next = longer[tries];
      if (edits.length === tries && next) {
        tries++;
        return {
          calls: [
            ...(tries === 1 ? [cite] : []),
            {
              tool: "edit_mind",
              input: {
                part: language === "English" ? "Summary" : "摘要",
                content: next.content,
                ...(next.times !== undefined && { times_as_long: next.times }),
              },
            },
          ],
        };
      }
      return { text: reply };
    },
    { generate: judgesNothing },
  );
}

async function askBoth(model: MockLanguageModelV4, language: Language, second: string) {
  const { core, mind, scope } = await setUp(model, language);
  const first = await askAssistant(core, {
    text: "Write a summary of the lease here",
    mindId: mind.id,
    scope,
  });
  const answer = await askAssistant(core, {
    text: second,
    mindId: mind.id,
    scope,
    conversationId: first.conversationId,
  });
  return { answer, page: await connectToMind(core, mind.id) };
}

const TOO_LONG =
  "## Summary\n\nRent is due on the first of each month [^1]. The deposit is two months of rent [^2]. The tenant pays for water and power [^3]. Pets need the landlord's written consent [^4].";
const A_BIT_LONGER =
  "## Summary\n\nRent is due on the first of each month [^1]. The deposit is two months of rent [^2]. The tenant pays for water and power [^3].";

describe("“Longer” at the length the User asked for", { timeout: 30_000 }, () => {
  // protects=new text twice as long as a "bit longer" asks is refused once, with the sizes to write it at counted from the Note's text, and the text written at that length lands, the result saying the multiple measured; fails_when=the doubled text lands, the refusal gives no sizes, or the result leaves the multiple to the model; no_claim=whether a real model gives times_as_long, which the live test counts.
  test("text off the length asked is refused once, with the sizes to write it at", async () => {
    const model = summaryModel("English", [
      { content: TOO_LONG, times: 1.5 },
      { content: A_BIT_LONGER, times: 1.5 },
    ]);

    const { answer, page } = await askBoth(model, "English", "make it a bit longer");

    const [refused, written] = mindCalls(answer).filter((call) => call.tool === "edit_mind");
    expect(refused?.status).toBe("failed");
    expect(refused?.mindProblem).toMatchObject({ kind: "length" });
    expect(written?.status).toBe("done");
    const told = model.doStreamCalls
      .flatMap((call) => call.prompt)
      .flatMap((message) => (message.role === "tool" ? message.content : []))
      .map((part) => (part.type === "tool-result" ? JSON.stringify(part.output) : ""))
      .join("\n");
    // "Summary" and two sentences of 9 and 7 words: 17; all four sentences make 30.
    expect(told).toContain(
      "the new text is 30 words, where the text there now is 17, and times_as_long asks for 1.5 times. Write it again at 21 to 28 words",
    );
    expect(lastResult(model)).toContain("(from 17 to 24 words, not shorter: 1.4 times as long)");
    expect(shownWithChanges(page)).toEqual([
      "+ Summary",
      "+ Rent is due on the first of each month ⟨found⟩. The deposit is two months of rent ⟨found⟩. The tenant pays for water and power ⟨found⟩.",
    ]);
  });

  // protects=the length is asked for once in an Answer: a second miss lands, and the result says how far it is from what was asked, so the reply can't call it the length asked; fails_when=it is refused again, or the result says nothing of the miss; no_claim=what a real model then says.
  test("a second miss lands, and the result says it is off what was asked", async () => {
    const model = summaryModel("English", [
      { content: TOO_LONG, times: 1.5 },
      { content: TOO_LONG, times: 1.5 },
    ]);

    const { answer } = await askBoth(model, "English", "make it a bit longer");

    expect(mindCalls(answer).map((call) => call.status)).toEqual(["failed", "done"]);
    expect(lastResult(model)).toContain(
      "(from 17 to 30 words, not shorter: 1.8 times as long, where the User asked for about 1.5 times)",
    );
  });

  // protects=with no length asked for (none given, or 1), new text is never refused for its length, and the result still gives the measured multiple; fails_when=it is refused, or its multiple is left out; no_claim=which length a real model picks.
  test.each([
    ["none given", undefined],
    ["1", 1],
  ])(
    "with no length asked for (%s), the result still gives the measured multiple",
    async (_, times) => {
      const model = summaryModel("English", [{ content: TOO_LONG, times }]);

      const { answer } = await askBoth(model, "English", "make it longer");

      expect(mindCalls(answer).map((call) => call.status)).toEqual(["done"]);
      expect(lastResult(model)).toContain("(from 17 to 30 words, not shorter: 1.8 times as long)");
    },
  );

  // protects=Chinese is measured in characters, each Han character one, as the Note's count counts; fails_when=it is counted in words, so a Chinese text reads as a few words long; no_claim=Japanese, which counts the same way.
  test("Chinese is measured in characters", async () => {
    const model = summaryModel("Chinese", [
      {
        content: "## 摘要\n\n房租在每月一日支付[^1]。押金为两个月的房租[^2]。租客自付水电费[^3]。",
        times: 1.5,
      },
    ]);

    await askBoth(model, "Chinese", "把摘要写得稍长一点");

    // "摘要" and 9 + 9 characters: 20; the third sentence adds 7.
    expect(lastResult(model)).toContain(
      "(from 20 to 27 characters, not shorter: 1.4 times as long)",
    );
  });
});

describe("What “longer” adds is cited", { timeout: 30_000 }, () => {
  // protects=a sentence added to cited text with no Citation is refused once by name, telling the model to cite it or leave it out, and the text without it lands; fails_when=the uncited sentence lands at once, or the refusal doesn't name it; no_claim=whether a real model then cites or drops it, which the live test counts.
  test.each([
    {
      language: "English" as const,
      added: "In practice this makes the lease fairly strict for the tenant.",
      content:
        "## Summary\n\nRent is due on the first of each month [^1]. The deposit is two months of rent [^2]. In practice this makes the lease fairly strict for the tenant.",
      shown: [
        "+ Summary",
        "+ Rent is due on the first of each month ⟨found⟩. The deposit is two months of rent ⟨found⟩. The tenant pays for water and power ⟨found⟩.",
      ],
    },
    {
      language: "Chinese" as const,
      added: "这对租客比较严格。",
      content: "## 摘要\n\n房租在每月一日支付[^1]。押金为两个月的房租[^2]。这对租客比较严格。",
      shown: [
        "+ 摘要",
        "+ 房租在每月一日支付⟨found⟩。押金为两个月的房租⟨found⟩。租客自付水电费⟨found⟩。",
      ],
    },
  ])("$language", async ({ language, added, content, shown }) => {
    const cited =
      language === "English"
        ? A_BIT_LONGER
        : "## 摘要\n\n房租在每月一日支付[^1]。押金为两个月的房租[^2]。租客自付水电费[^3]。";
    const model = summaryModel(language, [{ content }, { content: cited }]);

    const { answer, page } = await askBoth(model, language, "make it longer");

    const [refused, written] = mindCalls(answer).filter((call) => call.tool === "edit_mind");
    expect(refused?.mindProblem).toMatchObject({ kind: "uncited" });
    expect(written?.status).toBe("done");
    expect(changesIn(answer)).toHaveLength(1);
    const told = model.doStreamCalls
      .flatMap((call) => call.prompt)
      .flatMap((message) => (message.role === "tool" ? message.content : []))
      .map((part) => (part.type === "tool-result" ? JSON.stringify(part.output) : ""))
      .join("\n");
    expect(told).toContain(`this sentence you added cites nothing: “${added}”`);
    expect(shownWithChanges(page)).toEqual(shown);
  });

  // protects=a new claim made of words from two old sentences ("Two months are due on the first") is held to the old sentence closest to it, so it is refused, not taken for a restatement; fails_when=it lands uncited because each word is somewhere in the old text; no_claim=a claim that shares most words with one old sentence ("The deposit is due on the first of each month"), which word overlap can't tell from a restatement.
  test("a new claim made of the old text's words is refused", async () => {
    const model = summaryModel("English", [
      {
        content:
          "## Summary\n\nRent is due on the first of each month [^1]. The deposit is two months of rent [^2]. Two months are due on the first.",
      },
      { content: A_BIT_LONGER },
    ]);

    const { answer } = await askBoth(model, "English", "make it longer");

    expect(mindCalls(answer).map((call) => [call.status, call.mindProblem?.kind])).toEqual([
      ["failed", "uncited"],
      ["done", undefined],
    ]);
  });

  // protects=asked once, a sentence still added bare lands, and the result names it and says to say so, so the reply can't call it all cited; fails_when=it lands with nothing said of it; no_claim=what a real model then says.
  test("a sentence still added bare is named in the result", async () => {
    const bare =
      "## Summary\n\nRent is due on the first of each month [^1]. The deposit is two months of rent [^2]. In practice this makes the lease fairly strict for the tenant.";
    const model = summaryModel("English", [{ content: bare }, { content: bare }]);

    const { answer } = await askBoth(model, "English", "make it longer");

    expect(mindCalls(answer).map((call) => call.status)).toEqual(["failed", "done"]);
    expect(lastResult(model)).toContain(
      "It went in as written, and this sentence you added cites nothing: “In practice this makes the lease fairly strict for the tenant.”: say so, never that all of it is cited.",
    );
  });

  // protects=a sentence that restates the old text with no marker, and a sentence cited after its full stop, are not taken for added uncited claims; fails_when=either is refused; no_claim=a restatement that shares fewer words.
  test("a restated sentence and one cited after its full stop are not refused", async () => {
    const model = summaryModel("English", [
      {
        content:
          "## Summary\n\nRent is due on the first of each month [^1]. The deposit is two months of rent. The tenant pays for water and power.[^3]",
      },
    ]);

    const { answer } = await askBoth(model, "English", "make it longer");

    expect(mindCalls(answer).map((call) => call.status)).toEqual(["done"]);
  });
});

describe("A rewrite asked for a length", { timeout: 30_000 }, () => {
  // protects=edit_mind's rewrite by instruction is told the sizes to write at, counted from the text, when times_as_long is given, and nothing of them otherwise; fails_when=the rewrite is left to guess "a bit longer", or told sizes no one asked for; no_claim=how well a real rewrite keeps to them.
  test("is told the sizes to write at", async () => {
    const prompts: string[] = [];
    let asking = "";
    const model = scriptedModel(
      (call: ModelCall): ScriptedReply => {
        if ([EDIT_INSTRUCTIONS, EDIT_INSTRUCTIONS_NAMED].includes(call.system)) {
          prompts.push(call.prompt);
          return {
            text: "¶2 The quarter was very good, and sales were really strong all year.\n<why>Longer.</why>",
          };
        }
        return call.results.length === 0
          ? {
              calls: [
                {
                  tool: "edit_mind",
                  input: {
                    part: "Summary",
                    instruction: asking,
                    ...(asking.includes("bit") && { times_as_long: 1.5 }),
                  },
                },
              ],
            }
          : { text: "Done." };
      },
      { generate: judgesNothing },
    );
    const core = startCore(await createTempDataFolder(), {
      createChatModel: scriptedModels(model).createChatModel,
    });
    await core.saveChatProvider({ kind: "ollama", modelId: "local-model" });
    for (const [title, asked] of [
      ["Q3", "Make it a bit longer"],
      ["Q4", "Make it more formal"],
    ] as const) {
      const mind = await core.createMind({ title });
      const client = await connectToMind(core, mind.id);
      writeMind(client, [
        heading(2, "Summary"),
        note("The quarter was very good, and sales were really strong."),
      ]);
      await client.settled();
      asking = asked;
      await askAssistant(core, { text: asked, mindId: mind.id });
    }

    // "Summary" and a sentence of 10 words: 11.
    const longer = prompts.filter((prompt) => prompt.includes("Make it a bit longer"));
    const formal = prompts.filter((prompt) => prompt.includes("Make it more formal"));
    expect(longer.length).toBeGreaterThan(0);
    expect(formal.length).toBeGreaterThan(0);
    for (const prompt of longer) {
      expect(prompt).toContain("Make the whole passage 14 to 18 words long: it is 11 now.");
    }
    for (const prompt of formal) expect(prompt).not.toContain("Make the whole passage");
  });
});
