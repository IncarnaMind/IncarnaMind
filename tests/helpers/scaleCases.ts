/**
 * A Document's two rows read through the core as the assistant uses it, with a scripted model
 * that searches once, cites both rows and gives them to an Analysis as quoted numbers: what each
 * number is read as, and what the Analysis told the model (#2365). An Analysis's quoted number
 * is read as `calculate` read one before #3393, so its scale rules are pinned here.
 */
import type { MockLanguageModelV4 } from "ai/test";
import type { Core } from "../../src/core";
import { createFakeAnalysisRuntime } from "../../src/core/analysis/fake";
import { answerEnded, type ShownPassage, shownPassages } from "./citations";
import { createTempDataFolder, startCore } from "./core";
import { addAndProcess, writeSourceFile } from "./documents";
import { answerRequests, judgesNothing, scriptedModel, scriptedModels } from "./models";
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
 * A model that searches once, cites both rows from the Passage that writes them, gives both to
 * an Analysis as quoted numbers, and answers. `unitQuote` goes on both inputs.
 */
function analysingModel(
  query: string,
  cites: readonly [string, string],
  numbers: readonly [string, string],
  unitQuote: string | undefined,
  unitQuotes: UnitQuotes | undefined,
): MockLanguageModelV4 {
  return scriptedModel(
    (call) => {
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
        const input = (name: string, index: number) => {
          const quoted = unitQuotes?.[index] ?? unitQuote;
          return {
            name,
            citation: index + 1,
            number: numbers[index],
            ...(quoted !== undefined && { unitQuote: quoted }),
          };
        };
        const call: Call = {
          tool: "run_analysis",
          input: {
            title: "Difference",
            inputs: [input("rev", 0), input("cost", 1)],
            code: 'print(inputs["rev"] - inputs["cost"])',
          },
        };
        return { calls: [{ tool: "cite", input: { citations: cited } }, call] };
      }
      return { text: "Revenue and costs are in the report.[^1]" };
    },
    { generate: judgesNothing },
  );
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
  const asked = await core.askInConversation({ text: "What is the difference?", analyse: true });
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

/**
 * The two numbers as the Analysis read them: `value` is the first less the second, null when
 * either was refused; scale, currency, statement and unit are the first's.
 */
export async function record(c: Case) {
  const model = analysingModel(c.query, c.cites, c.numbers, c.unitQuote, c.unitQuotes);
  const core = startCore(await createTempDataFolder(), {
    createChatModel: scriptedModels(model).createChatModel,
    analysisRuntime: createFakeAnalysisRuntime(),
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
  const read = (answer.analyses[0]?.inputs ?? []).flatMap((each) =>
    each.kind === "figure" ? [each.input] : [],
  );
  const [rev, cost] = read;
  return {
    value: rev && cost ? rev.number.value - cost.number.value : null,
    scale: rev?.unitStatement?.scale ?? null,
    currency: rev?.unitStatement?.currency ?? null,
    statement: rev?.unitStatement?.citation.quote ?? null,
    unit: rev?.number.unit ?? null,
    asked: told(model, "run_analysis"),
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
