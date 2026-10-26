/** What `npm run eval:speed` reads from its INCARNAMIND_EVAL_SPEED_* variables (README.md). */
import { type Core, chatProviderKinds, type SaveChatProviderInput } from "../../src/core";
import { CNY_PER_USD } from "../../src/core/providers/catalog/billing";

export const env = (name: string) => process.env[`INCARNAMIND_EVAL_SPEED_${name}`]?.trim() || null;

export const list = (name: string) =>
  env(name)
    ?.split(",")
    .map((each) => each.trim())
    .filter(Boolean) ?? null;

/** What the core counted as spent, in dollars. */
export const spentUsd = async (core: Core) =>
  (await core.getCostSummary()).spent.reduce((sum, each) => {
    if (each.currency === "USD") return sum + each.amount;
    return each.currency === "CNY" ? sum + each.amount / CNY_PER_USD : sum;
  }, 0);

/** A model named "<kind>/<model id>", with its kind's key and endpoint (KEY_<KIND>, ENDPOINT_<KIND>). */
export function modelNamed(name: string, variable: string): SaveChatProviderInput {
  const [kind, ...rest] = name.split("/");
  const found = chatProviderKinds.find((known) => known === kind);
  if (!found || found === "chatgpt" || rest.length === 0) {
    throw new Error(`INCARNAMIND_EVAL_SPEED_${variable}: "${name}" isn't "<kind>/<model id>".`);
  }
  const apiKey = env(`KEY_${found.toUpperCase().replaceAll("-", "_")}`);
  const endpoint = env(`ENDPOINT_${found.toUpperCase().replaceAll("-", "_")}`);
  return {
    kind: found,
    modelId: rest.join("/"),
    ...(apiKey && { apiKey }),
    ...(endpoint && { endpoint }),
  };
}

export const modelsAsked = (): SaveChatProviderInput[] =>
  (list("MODELS") ?? []).map((each) => modelNamed(each, "MODELS"));
