/**
 * A model that only warns about a setting it doesn't take is sent that setting once, through the
 * core's public interface: a scripted model that takes a temperature, leaves it out and says so in
 * its reply's warnings, as OpenAI's reasoning models do.
 */
import { wrapLanguageModel } from "ai";
import { expect, test } from "vitest";
import { answerEnded } from "../helpers/citations";
import { createTempDataFolder, startCore } from "../helpers/core";
import { scriptedModel } from "../helpers/models";

/** A core whose model warns that a temperature isn't supported whenever a request carries one. */
async function coreWithWarningModel(warns: boolean) {
  const sent: (number | undefined)[] = [];
  const inner = scriptedModel(
    (call) => {
      sent.push(call.options.temperature);
      return { text: "Spring tides come at new moon." };
    },
    { generate: () => ({ text: "{}" }) },
  );
  const model = wrapLanguageModel({
    model: inner,
    middleware: {
      specificationVersion: "v4",
      wrapStream: async ({ doStream, params }) => {
        const result = await doStream();
        const warned = warns && params.temperature !== undefined;
        return {
          ...result,
          stream: result.stream.pipeThrough(
            new TransformStream({
              transform(part, controller) {
                controller.enqueue(
                  part.type === "stream-start" && warned
                    ? {
                        ...part,
                        warnings: [{ type: "unsupported" as const, feature: "temperature" }],
                      }
                    : part,
                );
              },
            }),
          ),
        };
      },
    },
  });
  const core = startCore(await createTempDataFolder(), { createChatModel: () => model });
  await core.saveChatProvider({ kind: "ollama", modelId: "local-model" });
  const ask = async (text: string) => {
    const asked = await core.askInConversation({ text });
    if (!asked.asked) throw new Error(`Not asked: ${JSON.stringify(asked)}`);
    await answerEnded(core, asked.answerId);
  };
  return { core, sent, ask };
}

// protects=a model the catalog doesn't know, whose reply warns that it doesn't support a temperature, gets a temperature once and none for the rest of the session, so the same warning isn't logged at every request; a model that doesn't warn keeps getting one; fails_when=a second request to the model that warned carries a temperature, or a model that never warned loses its temperature; no_claim=which models warn
test("a setting a model warns it doesn't support is sent once", async () => {
  const warning = await coreWithWarningModel(true);
  await warning.ask("When do spring tides come?");
  await warning.ask("And neap tides?");
  warning.core.close();

  expect(warning.sent.length).toBeGreaterThan(1);
  expect(warning.sent[0]).toBeTypeOf("number");
  expect(warning.sent.slice(1).every((temperature) => temperature === undefined)).toBe(true);

  const quiet = await coreWithWarningModel(false);
  await quiet.ask("When do spring tides come?");
  await quiet.ask("And neap tides?");
  quiet.core.close();

  expect(quiet.sent.length).toBeGreaterThan(1);
  expect(quiet.sent.every((temperature) => typeof temperature === "number")).toBe(true);
});
