import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { DATABASE_FILE } from "../../src/core";
import type { Consent } from "../../src/core/consent";
import { ChatNotReadyError } from "../../src/core/errors";
import { createChat } from "../../src/core/providers/chat";
import type { Secrets } from "../../src/core/secrets";
import type { SettingsStore } from "../../src/core/settings";
import { openDatabase } from "../../src/core/storage";
import { createMemoryKeychain, createTempDataFolder, startCore } from "../helpers/core";
import { replyingModel, scriptedModels } from "../helpers/models";

/*
 * A permit is for one run and one service (#2252): another service's decline still stops the
 * request, even when the permit is for the flow.
 */

describe("A run permit at model preparation", () => {
  test("a permit for another service cannot prepare a model the User declined", async () => {
    const dataDir = await createTempDataFolder();
    const core = startCore(dataDir, { keychain: createMemoryKeychain() });
    const openai = await core.saveChatProvider({
      kind: "openai",
      apiKey: "sk-test",
      modelId: "gpt-test",
    });
    const anthropic = await core.saveChatProvider({
      kind: "anthropic",
      apiKey: "sk-ant-test",
      modelId: "claude-test",
    });
    core.close();
    const db = openDatabase(join(dataDir, DATABASE_FILE));
    try {
      const consent = {
        status: () => "declined",
        ensure: async () => undefined,
        onThisComputer: () => false,
        allows: () => false,
        dataFlow: () => ({
          id: "classification",
          service: anthropic.service,
          sends: [],
        }),
        isBackground: () => true,
        registry: { register: () => undefined, get: () => undefined, list: () => [] },
      } as unknown as Consent;
      const settings = {
        get: () => ({ user: { chatModel: null }, device: {} }),
      } as unknown as SettingsStore;
      const secrets = {
        get: async () => "sk-test",
        tryRead: async () => ({ secret: "sk-test", unreadable: false }),
        tryGet: async () => "sk-test",
        set: async () => undefined,
      } as unknown as Secrets;
      const models = scriptedModels(replyingModel());
      const chat = createChat({
        db,
        now: () => new Date().toISOString(),
        settings,
        secrets,
        consent,
        createModel: models.createChatModel,
        chatGpt: { hasSignIn: async () => false } as never,
        claudeAccount: { hasSignIn: async () => false } as never,
        copilot: { hasSignIn: async () => false } as never,
        ollamaModels: {} as never,
        localOnly: () => false,
        meter: { wrap: (model: unknown) => model } as never,
      });
      const choice = { providerId: anthropic.id, modelId: "claude-test" };
      if (!openai.service || !anthropic.service) throw new Error("No service.");

      await expect(
        chat.prepareModel(choice, "classification", undefined, {
          permit: { flow: "classification", serviceId: openai.service.id },
        }),
      ).rejects.toThrow(ChatNotReadyError);

      const matched = await chat.prepareModel(choice, "classification", undefined, {
        permit: { flow: "classification", serviceId: anthropic.service.id },
      });
      expect(matched.provider.service?.id).toBe(anthropic.service.id);
    } finally {
      db.close();
    }
  });
});
