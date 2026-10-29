import { describe, expect, test } from "vitest";
import {
  type DataFlow,
  type DataFlowStatus,
  type ExternalService,
  JEV_DEFAULT_REVIEW_BAND,
  type JevSettings,
  type RegisteredDataFlow,
} from "../../src/core/api";
import { secondLookOn } from "../../src/renderer/src/checkSecondLook";

const TYPESAFE: ExternalService = { id: "https://api.typesafe.ai", name: "TypeSafe Jev" };
const ANTHROPIC: ExternalService = { id: "https://api.anthropic.com", name: "Anthropic" };

const jev = (over: Partial<JevSettings> = {}): JevSettings => ({
  enabled: true,
  hasApiKey: true,
  endpoint: null,
  model: "jev-latest",
  reviewBand: { ...JEV_DEFAULT_REVIEW_BAND },
  service: TYPESAFE,
  ...over,
});

const status = (
  flow: DataFlow["id"],
  service: ExternalService,
  consent: DataFlowStatus["consent"],
): DataFlowStatus => ({
  flow: { id: flow, service, sends: [] },
  consent,
  decidedAt: null,
  chosen: false,
});

const registered = (...statuses: DataFlowStatus[]): RegisteredDataFlow[] => {
  const byFlow = new Map<DataFlow["id"], DataFlowStatus[]>();
  for (const each of statuses)
    byFlow.set(each.flow.id, [...(byFlow.get(each.flow.id) ?? []), each]);
  return [...byFlow].map(([id, services]) => ({ id, sends: [], services }));
};

/*
 * The limit line on a Supported check card (#1927) goes once a second look by
 * Jev covers the check (#1926): Jev with its key, and the checks flow allowed
 * to send a Supported sentence and its quote to it.
 */
describe("when a Supported card says what a check can miss", () => {
  test("always, with no Jev on this device", () => {
    expect(secondLookOn(null, [])).toBe(false);
    expect(secondLookOn(null, registered(status("checks", TYPESAFE, "accepted")))).toBe(false);
  });

  test("while Jev is set up without a key its requests need", () => {
    expect(
      secondLookOn(jev({ hasApiKey: false }), registered(status("checks", TYPESAFE, "accepted"))),
    ).toBe(false);
  });

  test("while checks send nowhere near Jev", () => {
    expect(secondLookOn(jev(), registered(status("checks", ANTHROPIC, "accepted")))).toBe(false);
  });

  test("while the checks flow hasn't been allowed to send to Jev", () => {
    expect(secondLookOn(jev(), registered(status("checks", TYPESAFE, "not-asked")))).toBe(false);
    expect(secondLookOn(jev(), registered(status("checks", TYPESAFE, "declined")))).toBe(false);
  });

  test("while only another flow, such as tagging, is allowed to send to Jev", () => {
    expect(
      secondLookOn(
        jev(),
        registered(
          status("tagging", TYPESAFE, "accepted"),
          status("checks", ANTHROPIC, "accepted"),
        ),
      ),
    ).toBe(false);
  });

  test("never, once the checks flow is allowed to send to Jev", () => {
    expect(secondLookOn(jev(), registered(status("checks", TYPESAFE, "accepted")))).toBe(true);
    expect(
      secondLookOn(
        jev(),
        registered(status("checks", ANTHROPIC, "accepted"), status("checks", TYPESAFE, "accepted")),
      ),
    ).toBe(true);
  });

  test("a Jev-compatible server on this computer has no consent to allow, so it still says so", () => {
    expect(
      secondLookOn(jev({ service: null }), registered(status("checks", TYPESAFE, "accepted"))),
    ).toBe(false);
  });
});
