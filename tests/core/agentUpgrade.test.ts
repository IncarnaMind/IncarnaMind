import { join } from "node:path";
import { expect, test } from "vitest";
import { DATABASE_FILE } from "../../src/core";
import { agentSocketPath } from "../../src/core/agents";
import { openDatabase } from "../../src/core/storage";
import { agentSocketAnswers } from "../helpers/agentClients";
import { agentsAdapter, connectLegacyAgent } from "../helpers/agents";
import { createMemoryKeychain, createTempDataFolder, startCore } from "../helpers/core";

for (const language of ["en", "zh-CN"] as const) {
  test.each([true, false])(
    `a legacy profile enabled=%s keeps pairings but waits for new approval, ${language}`,
    async (enabled) => {
      const dataDir = await createTempDataFolder();
      const keychain = createMemoryKeychain();
      const agents = await agentsAdapter(dataDir);
      if (!agents) throw new Error("No agent adapter.");
      const socketPath = agentSocketPath(dataDir);
      const adapters = { keychain, agents };
      const original = startCore(dataDir, adapters);
      await original.updateSettings({ user: { language } });
      const folder = await original.createLibraryGroup({ name: "Coast", description: "Tides" });
      const kept = await original.connectAgent({ name: "Kept", folderIds: [folder.id] });
      const revoked = await original.connectAgent({ name: "Revoked", folderIds: [folder.id] });
      await original.disconnectAgent(revoked.pairing.id);
      await original.setAgentsEnabled(enabled);
      if (enabled) await expect.poll(() => agentSocketAnswers(socketPath)).toBe(true);
      original.close();
      await expect.poll(() => agentSocketAnswers(socketPath)).toBe(false);

      const db = openDatabase(join(dataDir, DATABASE_FILE));
      db.run("DELETE FROM schema_migrations WHERE version = 110");
      db.exec("PRAGMA user_version = 109");
      db.close();

      const upgraded = startCore(dataDir, adapters);
      expect(await upgraded.getAgents()).toMatchObject({
        enabled: false,
        pairings: [kept.pairing],
      });
      expect(await agentSocketAnswers(socketPath)).toBe(false);
      const retained = await upgraded.getAgentLaunch(kept.pairing.id);
      expect(retained.env.INCARNAMIND_AGENT_TOKEN === kept.launch.env.INCARNAMIND_AGENT_TOKEN).toBe(
        true,
      );
      expect(keychain.secrets.has(`agent-pairing:${revoked.pairing.id}`)).toBe(false);

      await upgraded.setAgentsEnabled(true);
      await expect.poll(() => agentSocketAnswers(socketPath)).toBe(true);
      const client = await connectLegacyAgent(retained);
      expect((await client.listTools()).tools.length).toBeGreaterThan(0);
      await client.close();
      upgraded.close();
      await expect.poll(() => agentSocketAnswers(socketPath)).toBe(false);

      const restarted = startCore(dataDir, adapters);
      expect(await restarted.getAgents()).toMatchObject({
        enabled: true,
        pairings: [kept.pairing],
      });
      await expect.poll(() => agentSocketAnswers(socketPath)).toBe(true);
    },
  );
}
