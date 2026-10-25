import { describe, expect, test } from "vitest";
import type { DataFlowId, DataFlowStatus, RegisteredDataFlow } from "../../src/core/api";
import { decisionOf, groupByService } from "../../src/renderer/src/privacyServices";

const OPENAI = { id: "https://api.openai.com", name: "OpenAI" };
const LOCAL_SERVER = { id: "https://llm.example.com", name: "llm.example.com" };

const status = (
  id: DataFlowId,
  service: typeof OPENAI,
  state: Partial<Pick<DataFlowStatus, "consent" | "decidedAt" | "chosen">> = {},
): DataFlowStatus => ({
  flow: { id, service, sends: ["blocks"] },
  consent: "accepted",
  decidedAt: "2026-10-19T10:00:00.000Z",
  chosen: true,
  ...state,
});

const flow = (id: DataFlowId, ...services: DataFlowStatus[]): RegisteredDataFlow => ({
  id,
  sends: ["blocks"],
  services,
});

const uses = (...statuses: DataFlowStatus[]) =>
  groupByService(statuses.map((each) => flow(each.flow.id, each)))[0]?.uses ?? [];

describe("groupByService", () => {
  test("gives each service one group, in the order the services first appear", () => {
    const groups = groupByService([
      flow("chat", status("chat", OPENAI)),
      flow("tagging", status("tagging", LOCAL_SERVER), status("tagging", OPENAI)),
      flow("edits", status("edits", OPENAI)),
    ]);
    expect(groups.map((group) => group.service.name)).toEqual(["OpenAI", "llm.example.com"]);
    expect(groups[0]?.uses.map((use) => use.flow)).toEqual(["chat", "tagging", "edits"]);
    expect(groups[1]?.uses.map((use) => use.flow)).toEqual(["tagging"]);
  });

  test("leaves out a flow that goes nowhere", () => {
    expect(groupByService([flow("chat")])).toEqual([]);
  });
});

describe("decisionOf", () => {
  test("a service allowed everywhere is allowed once, with the first date and whether it was chosen", () => {
    expect(
      decisionOf(
        uses(
          status("chat", OPENAI, { decidedAt: "2026-10-19T10:00:00.000Z" }),
          status("tagging", OPENAI, { decidedAt: "2026-10-12T10:00:00.000Z", chosen: false }),
        ),
      ),
    ).toEqual({ kind: "accepted", chosen: false, at: "2026-10-12T10:00:00.000Z" });
    expect(decisionOf(uses(status("chat", OPENAI)))).toEqual({
      kind: "accepted",
      chosen: true,
      at: "2026-10-19T10:00:00.000Z",
    });
  });

  test("a service allowed for some uses says so", () => {
    expect(
      decisionOf(
        uses(
          status("chat", OPENAI),
          status("tagging", OPENAI, { consent: "not-asked", decidedAt: null, chosen: false }),
        ),
      ),
    ).toEqual({ kind: "partly" });
  });

  test("one with nothing allowed says the worst of its uses", () => {
    const notAsked = status("chat", OPENAI, { consent: "not-asked", decidedAt: null });
    const sendsMore = status("edits", OPENAI, { consent: "not-asked" });
    const declined = status("tagging", OPENAI, {
      consent: "declined",
      decidedAt: "2026-10-18T10:00:00.000Z",
    });
    expect(decisionOf(uses(notAsked))).toEqual({ kind: "not-asked" });
    expect(decisionOf(uses(notAsked, sendsMore))).toEqual({ kind: "sendsMore" });
    expect(decisionOf(uses(notAsked, sendsMore, declined))).toEqual({
      kind: "declined",
      at: "2026-10-18T10:00:00.000Z",
    });
  });
});
