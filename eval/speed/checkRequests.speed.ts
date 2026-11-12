/**
 * What a check sends, request by request, on the scripted model, for comparing two trees before a
 * gate's numbers are carried from one to the other (#2532): a write's check at six and at twelve,
 * and an Answer's own check of the same sentences. Each request's instructions, messages, Tools,
 * output limit, temperature, options and the models asked for, with ids, times and folders
 * written as placeholders. Runs only with INCARNAMIND_EVAL_SPEED_CHECK_REQUESTS set to the JSON
 * file it writes; no request is paid for.
 */
import { writeFileSync } from "node:fs";
import type { LanguageModelV4CallOptions } from "@ai-sdk/provider";
import { test } from "vitest";
import { writeChecked } from "../../tests/helpers/writeChecked";

const OUT = process.env.INCARNAMIND_EVAL_SPEED_CHECK_REQUESTS;

const ID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
const TIME = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g;
const FOLDER = /\/[^\s"]*incarnamind-[^\s"/]*/g;

/** A request as it was sent, with what differs from run to run written as placeholders. */
function sent(kind: "stream" | "generate", options: LanguageModelV4CallOptions): string {
  const request = {
    kind,
    prompt: options.prompt,
    tools: options.tools ?? [],
    toolChoice: options.toolChoice ?? null,
    maxOutputTokens: options.maxOutputTokens ?? null,
    temperature: options.temperature ?? null,
    responseFormat: options.responseFormat ?? null,
    providerOptions: options.providerOptions ?? null,
  };
  return JSON.stringify(request)
    .replace(ID, "<id>")
    .replace(TIME, "<time>")
    .replace(FOLDER, "<folder>");
}

async function requestsOf(flow: "write" | "answer", atOnce: number) {
  const written = await writeChecked(12, atOnce);
  if (flow === "write") await written.ask();
  else await written.answer();
  const { streamed, generated, models } = written.sent();
  const all = [
    ...streamed.map((each) => sent("stream", each)),
    ...generated.map((each) => sent("generate", each)),
  ].sort();
  return { flow, atOnce, models: [...new Set(models)].sort(), requests: all };
}

test.skipIf(!OUT)("what a check sends, request by request", async () => {
  const runs = [
    await requestsOf("write", 6),
    await requestsOf("write", 12),
    await requestsOf("answer", 6),
  ];
  if (OUT) writeFileSync(OUT, `${JSON.stringify(runs, null, 1)}\n`);
});
