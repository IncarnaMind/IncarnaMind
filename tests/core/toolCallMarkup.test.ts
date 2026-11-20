/**
 * A model's malformed Tool call runs the call's own markup into its text (#3476): written as it
 * came, a Note would hold `</content><parameter name="after">` as words. The assistant's
 * Note-writing Tools refuse such text in a plain line, so the model sends the call again, and
 * write a Note that quotes the markup in code as it is. The model's calls are scripted here.
 */
import type { MockLanguageModelV4 } from "ai/test";
import { describe, expect, test } from "vitest";
import { askAssistant, mindCalls } from "../helpers/assistant";
import { createTempDataFolder, startCore } from "../helpers/core";
import { connectToMind } from "../helpers/mindClient";
import { heading, note, shownWithChanges, writeMind } from "../helpers/minds";
import {
  judgesNothing,
  type ModelCall,
  type ScriptedReply,
  scriptedModel,
  scriptedModels,
} from "../helpers/models";

/** As Claude Haiku 5.5 sent it in #3462's measurement: the next argument's markup in the text. */
const LEAKED = 'The yield rose in 2023.</content>\n<parameter name="after">Untitled';
const FINE = "The yield rose in 2023.";

/** Calls `first`, then, told why it was refused, `then`; the results each call got are kept. */
function callsTwice(
  first: { tool: string; input: Record<string, unknown>; streamInput?: boolean },
  then: { tool: string; input: Record<string, unknown> } | null,
  told: string[],
) {
  return scriptedModel(
    ({ results }: ModelCall): ScriptedReply => {
      if (results.length === 0) return { calls: [first] };
      told.push(results.at(-1)?.text ?? "");
      if (results.length === 1 && then) return { calls: [then] };
      return { text: "Done." };
    },
    { generate: judgesNothing },
  );
}

async function setUp(model: MockLanguageModelV4) {
  const core = startCore(await createTempDataFolder(), {
    createChatModel: scriptedModels(model).createChatModel,
  });
  await core.saveChatProvider({ kind: "ollama", modelId: "local-model" });
  const mind = await core.createMind({ title: "Harvest" });
  const client = await connectToMind(core, mind.id);
  writeMind(client, [heading(2, "Summary"), note("The harvest was early.")]);
  await client.settled();
  return { core, mind, client };
}

describe("A Tool call's own markup never goes into a Note (#3476)", { timeout: 30_000 }, () => {
  // protects=text that carries the call's own argument markup is refused, as it streamed in too, and the model told plainly so it sends the call again; fails_when=the markup is written into the Note as words, or what streamed in before it stays
  test.each([false, true])(
    "add_to_mind refuses the markup and writes the call sent again (streamed: %s)",
    async (streamInput) => {
      const told: string[] = [];
      const leaked = `## Yield\n\nThe harvest came early.\n\n${LEAKED}`;
      const model = callsTwice(
        { tool: "add_to_mind", input: { content: leaked }, streamInput },
        { tool: "add_to_mind", input: { content: `## Yield\n\n${FINE}` } },
        told,
      );
      const { core, mind, client } = await setUp(model);

      const answer = await askAssistant(core, { text: "Add the yield", mindId: mind.id });
      await client.settled();

      expect(told[0]).toBe(
        "Error: Nothing was added to “Harvest”: content holds the markup of the call itself, </content>, not words for the Note. Send the call again with each argument in its own field.",
      );
      expect(mindCalls(answer).map((call) => [call.status, call.mindProblem?.kind])).toEqual([
        ["failed", "call-markup"],
        ["done", undefined],
      ]);
      expect(shownWithChanges(client)).toEqual([
        "Summary",
        "The harvest was early.",
        "+ Yield",
        `+ ${FINE}`,
      ]);
    },
  );

  // protects=a new Note made for text that carries call markup isn't left behind, empty or half written; fails_when=a Note named for the call stays
  test("create_mind makes no Note of text or a title that holds the markup", async () => {
    for (const input of [
      { title: "Yield", content: LEAKED },
      { title: 'Yield</title>\n<parameter name="content">', content: FINE },
    ]) {
      const told: string[] = [];
      const model = callsTwice({ tool: "create_mind", input, streamInput: true }, null, told);
      const { core, mind } = await setUp(model);
      await askAssistant(core, { text: "Write the yield as a new note", mindId: mind.id });
      expect(told[0]).toMatch(/holds the markup of the call itself/);
      expect((await core.listMinds()).map((each) => each.title)).toEqual(["Harvest"]);
    }
  });

  // protects=edit_mind's own new words are held to the same rule; fails_when=a replacement carrying the markup is written
  test("edit_mind refuses new words that hold the markup", async () => {
    const told: string[] = [];
    const model = callsTwice(
      {
        tool: "edit_mind",
        input: { old_text: "early", new_text: 'late</new_text>\n<parameter name="part">Summary' },
      },
      null,
      told,
    );
    const { core, mind, client } = await setUp(model);
    await askAssistant(core, { text: "Say it was late", mindId: mind.id });
    await client.settled();
    expect(told[0]).toMatch(/^Error: Nothing was changed in “Harvest”: new_text holds the markup/);
    expect(shownWithChanges(client)).toEqual(["Summary", "The harvest was early."]);
  });

  // protects=the whole new text of the assistant's own words, given to edit_mind as content, is held to the same rule; fails_when=its own text is rewritten with the markup in it
  test("edit_mind refuses its own text given again with the markup", async () => {
    const told: string[] = [];
    const model = scriptedModel(
      ({ results }: ModelCall): ScriptedReply => {
        if (results.length === 0)
          return { calls: [{ tool: "add_to_mind", input: { content: `## Yield\n\n${FINE}` } }] };
        if (results.length === 1) {
          return {
            calls: [
              {
                tool: "edit_mind",
                input: {
                  part: "Yield",
                  content: `## Yield\n\n${LEAKED}`,
                  times_as_long: 1,
                  removes_only: false,
                },
              },
            ],
          };
        }
        told.push(results.at(-1)?.text ?? "");
        return { text: "Done." };
      },
      { generate: judgesNothing },
    );
    const { core, mind, client } = await setUp(model);
    await askAssistant(core, { text: "Add the yield, then reword it", mindId: mind.id });
    await client.settled();
    expect(told[0]).toMatch(/^Error: Nothing was changed in “Harvest”: content holds the markup/);
    expect(shownWithChanges(client)).toEqual([
      "Summary",
      "The harvest was early.",
      "+ Yield",
      `+ ${FINE}`,
    ]);
  });

  // protects=a Note that quotes the markup on purpose, in a code block or a code span, is written as asked; fails_when=it is refused
  test("writes the markup quoted in a code block or a code span", async () => {
    const told: string[] = [];
    const quoted = [
      'A malformed call ends its text with `</content><parameter name="after">`.',
      "",
      "```xml",
      "</content>",
      '<parameter name="after">Untitled',
      "```",
    ].join("\n");
    const model = callsTwice({ tool: "add_to_mind", input: { content: quoted } }, null, told);
    const { core, mind, client } = await setUp(model);
    const answer = await askAssistant(core, { text: "Note how the call broke", mindId: mind.id });
    await client.settled();
    expect(mindCalls(answer).map((call) => call.status)).toEqual(["done"]);
    expect(shownWithChanges(client)).toContain(
      '+ A malformed call ends its text with </content><parameter name="after">.',
    );
  });
});
