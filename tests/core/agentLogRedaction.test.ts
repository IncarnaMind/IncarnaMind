import { randomBytes } from "node:crypto";
import { expect, test } from "vitest";
import { redactAgentKeys } from "../helpers/agentClients";
import { startAgentsCore } from "../helpers/agents";
import { replyingModel } from "../helpers/models";

for (const language of ["en", "zh-CN"] as const) {
  test(`failure artifacts remove an actual generated pairing key, ${language}`, async () => {
    const { core } = await startAgentsCore(replyingModel());
    await core.updateSettings({ user: { language } });
    const { launch } = await core.connectAgent({ name: "Claude Code" });
    const token = launch.env.INCARNAMIND_AGENT_TOKEN;
    if (!token) throw new Error("No pairing credential generated.");
    const line = language === "en" ? "Agent connection failed" : "智能体连接失败";
    for (const content of [
      token,
      `${line}: ${token}`,
      `prefix${token}suffix`,
      `${token} ${token}`,
    ]) {
      const redacted = redactAgentKeys(content);
      expect(redacted.includes(token)).toBe(false);
      expect(redacted.includes("[redacted]")).toBe(true);
    }
    expect(redactAgentKeys(line)).toBe(line);
    expect(redactAgentKeys("[redacted]")).toBe("[redacted]");
    for (let n = 0; n < 1_000; n++) {
      const generated = `im_${randomBytes(32).toString("base64url")}`;
      expect(redactAgentKeys(generated).includes(generated)).toBe(false);
    }
  });
}
