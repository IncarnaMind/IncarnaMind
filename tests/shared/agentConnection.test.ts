import { expect, test } from "vitest";
import { SHOW_AGENT_CONNECTION, SHOW_GOOGLE_PLAN_SETUP } from "../../src/shared/agentConnection";

test("outside-agent connections are offered in every public-alpha build", () => {
  expect(SHOW_AGENT_CONNECTION).toBe(true);
});

test("the Google plan-setup route follows its own release decision", () => {
  expect(SHOW_GOOGLE_PLAN_SETUP).toBe(false);
});
