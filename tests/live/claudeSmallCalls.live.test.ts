/**
 * The small calls (thinking off, #907) against the Claude models that refuse
 * `thinking: disabled`, and Haiku, which takes it: tagging one Document and a
 * claim check, through the core as the app uses it. Tagging runs on the
 * provider's quick-tasks model, Haiku 5.5, whichever model was chosen; the
 * check runs on the chosen model. Runs only with the key in the environment
 * (INCARNAMIND_LIVE_ANTHROPIC_KEY), and makes no request without one.
 * INCARNAMIND_LIVE_ANTHROPIC_SMALL_MODELS lists the models, comma separated;
 * Haiku 5.5, Sonnet 5.5 and Opus 5.5 by default. A few cents a run.
 * INCARNAMIND_LIVE_REPORT keeps what each request to which model asked of thinking.
 */
import { appendFile } from "node:fs/promises";
import { describe, expect, onTestFinished, test, vi } from "vitest";
import { createAiSdkChatModel } from "../../src/core";
import { catalogFacts } from "../../src/core/providers/catalog";
import { catalogProvider } from "../../src/core/providers/catalog/providers";
import { createTempDataFolder, startCore, turnOnAutomaticTagging } from "../helpers/core";
import { addAndProcess, writeSourceFile } from "../helpers/documents";
import { waitForTagging } from "../helpers/tags";

const KEY = process.env.INCARNAMIND_LIVE_ANTHROPIC_KEY;
const MODELS = (
  process.env.INCARNAMIND_LIVE_ANTHROPIC_SMALL_MODELS ??
  "claude-haiku-5-5,claude-sonnet-5-5,claude-opus-5-5"
)
  .split(",")
  .map((each) => each.trim())
  .filter(Boolean);

const TIDES = [
  "# Harbour notes",
  "",
  "Spring tides come twice a month, near the new and the full Moon.",
  "Neap tides come at the quarter Moons, when the range is smallest.",
].join("\n");

/** What each request to Anthropic asked of thinking, which model it went to, and every refusal. */
function recordRequests() {
  const original = globalThis.fetch;
  const sent: { model: string; thinking: unknown; effort: unknown }[] = [];
  const refused: string[] = [];
  const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const response = await original(input as Parameters<typeof original>[0], init);
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith("https://api.anthropic.com/v1/messages") && typeof init?.body === "string") {
      const body = JSON.parse(init.body) as {
        model: string;
        thinking?: unknown;
        output_config?: { effort?: unknown };
      };
      sent.push({
        model: body.model,
        thinking: body.thinking,
        effort: body.output_config?.effort,
      });
      if (!response.ok) refused.push(`${response.status} ${await response.clone().text()}`);
    }
    return response;
  });
  onTestFinished(() => spy.mockRestore());
  return { sent, refused };
}

const thinkingOffForm = (modelId: string) =>
  (
    catalogFacts("anthropic", modelId)?.thinkingOff ??
    catalogProvider("anthropic")?.request?.thinkingOff?.options
  )?.anthropic;

describe.each(MODELS)("%s, live", (model) => {
  test.skipIf(KEY === undefined)(
    "tags a Document and checks a claim, each asked not to think as the model takes it",
    { timeout: 600_000 },
    async () => {
      const requests = recordRequests();
      const core = startCore(await createTempDataFolder(), {
        createChatModel: createAiSdkChatModel,
      });
      core.on("consent.requested", (asked) => void core.respondToConsent(asked.requestId, true));
      const saved = await core.saveChatProvider({
        kind: "anthropic",
        apiKey: KEY ?? "",
        modelId: model,
      });
      if (saved.service) {
        await core.allowDataFlow("tagging", saved.service.id);
        await core.allowDataFlow("checks", saved.service.id);
      }
      // Automatic tagging is off for a cloud model until the switch is on, and turning it on is its consent (#1617).
      await turnOnAutomaticTagging(core);
      const sources = await createTempDataFolder();
      const [document] = await addAndProcess(core, [
        await writeSourceFile(sources, "Harbour notes.md", TIDES),
      ]);
      const [tagged] = await waitForTagging(core, [document?.id ?? ""], undefined, 180_000);
      expect(tagged?.tagging).toBe("tagged");
      const tagging = requests.sent.slice();

      const check = await core.checkClaim({ claim: "Spring tides come near the full Moon." });
      expect(check.verdict).not.toBe("not-checked");

      if (process.env.INCARNAMIND_LIVE_REPORT) {
        await appendFile(
          process.env.INCARNAMIND_LIVE_REPORT,
          `## ${model}\n${JSON.stringify(requests.sent)}\ncheck: ${check.verdict}\n\n`,
        );
      }
      expect(requests.refused).toEqual([]);
      const checked = requests.sent.slice(tagging.length);
      expect(new Set(tagging.map((each) => each.model))).toEqual(
        new Set([catalogProvider("anthropic")?.roles.quickTasks]),
      );
      expect(new Set(checked.map((each) => each.model))).toEqual(new Set([model]));
      for (const each of requests.sent) {
        const form = thinkingOffForm(each.model);
        expect({ thinking: each.thinking, effort: each.effort }, each.model).toEqual({
          thinking: form?.thinking,
          effort: form?.effort,
        });
      }
    },
  );
});
