/**
 * A Document's two rows calculated through the core as the assistant uses it, with a scripted
 * model that searches once, cites both rows and works out their difference: what the figure
 * records, and what the calculation told the model (#2365).
 */
import type { MockLanguageModelV4 } from "ai/test";
import type { Core } from "../../src/core";
import { answerEnded, type ShownPassage, shownPassages } from "./citations";
import { createTempDataFolder, startCore } from "./core";
import { addAndProcess, writeSourceFile } from "./documents";
import { answerRequests, scriptedModel, scriptedModels } from "./models";
import { buildPdf } from "./pdf";

type Call = { tool: string; input: unknown };
export type UnitQuotes = readonly [string | undefined, string | undefined];

function passageWriting(passages: readonly ShownPassage[], quote: string): ShownPassage {
  const found = passages.find((each) => each.text.includes(quote));
  if (!found) {
    const shown = passages.map((each) => JSON.stringify(each.text.slice(0, 200))).join(" | ");
    throw new Error(`No Passage writes "${quote}". Shown: ${shown}`);
  }
  return found;
}

/**
 * A model that searches once, cites both rows from the Passage that writes them, works out the
 * second from the first, and writes the marker. `unitQuote` goes on both inputs.
 */
function calculatingModel(
  query: string,
  cites: readonly [string, string],
  numbers: readonly [string, string],
  unitQuote: string | undefined,
  unitQuotes: UnitQuotes | undefined,
): MockLanguageModelV4 {
  return scriptedModel((call) => {
    const searches = call.results.filter((result) => result.tool === "search_documents");
    if (searches.length === 0) {
      return { calls: [{ tool: "search_documents", input: { query } }] };
    }
    if (call.index === 1) {
      const passages = searches.flatMap((each) => shownPassages(each.text));
      const cited = cites.map((quote, index) => {
        const passage = passageWriting(passages, quote);
        return {
          marker: index + 1,
          passage: passage.id,
          location: passage.location ?? "p. 1",
          quote,
        };
      });
      const input = (name: string, label: string, index: number) => {
        const quoted = unitQuotes?.[index] ?? unitQuote;
        return {
          name,
          label,
          citation: index + 1,
          number: numbers[index],
          ...(quoted !== undefined && { unitQuote: quoted }),
        };
      };
      const call: Call = {
        tool: "calculate",
        input: {
          figures: [
            {
              marker: 1,
              label: "Difference",
              formula: "rev - cost",
              inputs: [input("rev", "Revenue", 0), input("cost", "Costs", 1)],
            },
          ],
        },
      };
      return { calls: [{ tool: "cite", input: { citations: cited } }, call] };
    }
    return { text: "[=1][^1]" };
  });
}

function told(model: MockLanguageModelV4, tool: string): string {
  const last = answerRequests(model).at(-1);
  if (!last) return "";
  const texts: string[] = [];
  for (const message of last.prompt) {
    if (message.role !== "tool") continue;
    for (const part of message.content) {
      if (part.type === "tool-result" && part.toolName === tool && part.output.type === "text")
        texts.push(part.output.value);
    }
  }
  return texts.join("\n");
}

async function askAndRead(core: Core) {
  const asked = await core.askInConversation({ text: "What is the difference?" });
  if (!asked.asked) throw new Error(`The Question wasn't asked: ${JSON.stringify(asked)}`);
  const ended = await answerEnded(core, asked.answerId);
  if (ended.event !== "finished") throw new Error(`The Answer failed: ${JSON.stringify(ended)}`);
  const content = await core.getConversation(asked.conversation.id);
  const answer = content.messages.find((message) => message.id === asked.answerId);
  if (answer?.kind !== "answer") throw new Error("No Answer.");
  return answer;
}

export interface Case {
  file: { name: string; contents: string | Uint8Array };
  /** The two rows' quotes, cited from 1, and their numbers as written. */
  cites: readonly [string, string];
  numbers: readonly [string, string];
  unitQuote?: string;
  unitQuotes?: UnitQuotes;
  query: string;
}

export async function record(c: Case) {
  const model = calculatingModel(c.query, c.cites, c.numbers, c.unitQuote, c.unitQuotes);
  const core = startCore(await createTempDataFolder(), {
    createChatModel: scriptedModels(model).createChatModel,
    answerPaths: { retrievesFirst: () => false },
  });
  const saved = await core.saveChatProvider({
    kind: "anthropic",
    apiKey: "sk-test",
    modelId: "claude-haiku-5-5",
  });
  if (saved.service) await core.allowDataFlow("chat", saved.service.id);
  const sources = await createTempDataFolder();
  await addAndProcess(core, [await writeSourceFile(sources, c.file.name, c.file.contents)]);
  const answer = await askAndRead(core);
  core.close();
  return {
    value: answer.figures[0]?.value ?? null,
    scale: answer.figures[0]?.inputs[0]?.unitStatement?.scale ?? null,
    currency: answer.figures[0]?.inputs[0]?.unitStatement?.currency ?? null,
    statement: answer.figures[0]?.inputs[0]?.unitStatement?.citation.quote ?? null,
    unit: answer.figures[0]?.inputs[0]?.number.unit ?? null,
    asked: told(model, "calculate"),
  };
}

export const pdf = (name: string, lines: readonly string[]) => ({
  name: `${name}.pdf`,
  contents: buildPdf([{ lines }]),
});
export const pdfZh = (name: string, lines: readonly string[]) => ({
  name: `${name}.pdf`,
  contents: buildPdf([{ chineseLines: lines }]),
});
