/**
 * A live test's model, billed as it goes (#2378): every request's tokens, priced as the catalog
 * prices its model, so a run reports what it cost and can stop at its cap.
 */
import { costOf, inCurrency } from "../../src/core/cost/price";
import { catalogModel } from "../../src/core/providers/catalog";
import { type ChatModelFactory, createAiSdkChatModel } from "../../src/core/providers/models";

interface Billed {
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
}
type Usage = {
  inputTokens?: { total?: number; cacheRead?: number; cacheWrite?: number };
  outputTokens?: { total?: number };
};
const billedOf = (usage: Usage | undefined): Billed => ({
  input: usage?.inputTokens?.total ?? 0,
  cacheRead: usage?.inputTokens?.cacheRead ?? 0,
  cacheWrite: usage?.inputTokens?.cacheWrite ?? 0,
  output: usage?.outputTokens?.total ?? 0,
});

/** `spent` is in US dollars, whatever currency the catalog prices the model in. */
export function billedModels(model: string, provider = "anthropic") {
  const price = catalogModel(provider, model)?.price;
  const billed: Billed[] = [];
  const priced = (each: Billed) =>
    price
      ? inCurrency(
          costOf(
            {
              inputTokens: each.input,
              cachedInputTokens: each.cacheRead,
              cacheWriteTokens: each.cacheWrite,
              outputTokens: each.output,
            },
            price,
            new Date(),
            { cacheWrites: true },
          ),
          price.currency,
          "USD",
        )
      : 0;
  const spent = () => billed.reduce((total, each) => total + priced(each), 0);
  const tokens = () =>
    billed.reduce<Billed & { requests: number }>(
      (total, each) => ({
        requests: total.requests + 1,
        input: total.input + each.input,
        cacheRead: total.cacheRead + each.cacheRead,
        cacheWrite: total.cacheWrite + each.cacheWrite,
        output: total.output + each.output,
      }),
      { requests: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
    );
  const createChatModel: ChatModelFactory = (spec) => {
    const made = createAiSdkChatModel(spec);
    return new Proxy(made, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver);
        if (property === "doGenerate" && typeof value === "function")
          return async (...args: unknown[]) => {
            const result = (await value.apply(target, args)) as { usage?: Usage };
            billed.push(billedOf(result.usage));
            return result;
          };
        if (property === "doStream" && typeof value === "function")
          return async (...args: unknown[]) => {
            const result = (await value.apply(target, args)) as {
              stream: ReadableStream<{ type: string; usage?: Usage }>;
            };
            const [given, read] = result.stream.tee();
            const entry = billedOf(undefined);
            billed.push(entry);
            void (async () => {
              const reader = read.getReader();
              for (let part = await reader.read(); !part.done; part = await reader.read())
                if (part.value.type === "finish") Object.assign(entry, billedOf(part.value.usage));
            })().catch(() => {
              // A stream that failed or was stopped costs what its finish part said, if it came.
            });
            return { ...result, stream: given };
          };
        return value;
      },
    });
  };
  return { createChatModel, spent, tokens };
}
