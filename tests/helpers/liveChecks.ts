/**
 * A live test's chat model: the Answer and everything else scripted, and only a check's requests
 * sent to the real model, so a run bills only what it measures (#2378).
 */
import type { MockLanguageModelV4 } from "ai/test";
import type { ChatModelFactory } from "../../src/core/providers/models";

/** A check's request: everything else of the Answer is scripted, so only checks are billed. */
const CHECKS = /^You check(ed)? (one|a) sentence/;

/** A check's Figures line as the model wrote it, so a run can be read for what the judge said. */
async function figuresLine(
  stream: ReadableStream<{ type: string; delta?: string }>,
  heard: string[],
): Promise<void> {
  let text = "";
  const reader = stream.getReader();
  for (let part = await reader.read(); !part.done; part = await reader.read())
    if (part.value.type === "text-delta") text += part.value.delta ?? "";
  const line = text.split("\n").findLast((each) => each.startsWith("Figures:"));
  if (line) heard.push(line.slice(0, 1500));
}

/** `scripted` answers everything but a check, which goes to `real`; each check's Figures line lands in `heard`. */
export function routedChecks(
  scripted: MockLanguageModelV4,
  real: ChatModelFactory,
  heard: string[],
): ChatModelFactory {
  return (spec) => {
    const check = real(spec);
    const systemOf = (options: unknown): string => {
      const prompt = (options as { prompt?: { role?: string; content?: unknown }[] }).prompt ?? [];
      const system = prompt.find((message) => message.role === "system")?.content;
      return typeof system === "string" ? system : "";
    };
    return new Proxy(scripted, {
      get(target, property, receiver) {
        if (property === "doGenerate" || property === "doStream")
          return (options: unknown) => {
            const model = CHECKS.test(systemOf(options)) ? check : target;
            const method = Reflect.get(model, property) as (options: unknown) => Promise<unknown>;
            if (model !== check || property !== "doStream") return method.call(model, options);
            return method.call(model, options).then((result) => {
              const streamed = result as {
                stream: ReadableStream<{ type: string; delta?: string }>;
              };
              const [given, read] = streamed.stream.tee();
              void figuresLine(read, heard).catch(() => {
                // A stream that failed leaves no Figures line to read.
              });
              return { ...streamed, stream: given };
            });
          };
        return Reflect.get(target, property, receiver);
      },
    });
  };
}
