import { expect, test } from "vitest";
import { SHOW_AGENT_CONNECTION, SHOW_CLAUDE_APP_SETUP } from "../../src/shared/agentConnection";

test("outside-agent connections are offered in every public-alpha build", () => {
  expect(SHOW_AGENT_CONNECTION).toBe(true);
});

test("the Claude model-setup shortcut follows its own release decision", () => {
  expect(SHOW_CLAUDE_APP_SETUP).toBe(false);
});
