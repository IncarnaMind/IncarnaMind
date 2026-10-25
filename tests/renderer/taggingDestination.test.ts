import { expect, test } from "vitest";
import type { RegisteredDataFlow } from "../../src/core/api";
import {
  destinationFrom,
  destinationOf,
  unknownDestination,
} from "../../src/renderer/src/taggingDestination";

const service = { id: "https://api.anthropic.com", name: "Anthropic" };

const sent = (consent: "accepted" | "declined" | "not-asked"): RegisteredDataFlow => ({
  id: "tagging",
  sends: ["tags", "document-excerpts"],
  services: [
    {
      flow: { id: "tagging", service, sends: ["tags", "document-excerpts"] },
      consent,
      decidedAt: null,
      chosen: consent === "accepted",
    },
  ],
});

test("nothing is known until the flows are read", async () => {
  let answer: (flows: RegisteredDataFlow[]) => void = () => {};
  const reading = destinationFrom(
    () =>
      new Promise<RegisteredDataFlow[]>((resolve) => {
        answer = resolve;
      }),
    "tagging",
    () => {},
  );
  // The state the status row starts in, and stays in while its read is in flight.
  expect(unknownDestination).toEqual({ where: "unknown" });
  let answered = false;
  void reading.then(() => (answered = true));
  await Promise.resolve();
  expect(answered).toBe(false);
  answer([]);
  await expect(reading).resolves.toEqual({ where: "local" });
});

test("a flow with no service runs on this computer, and so does one that isn't registered", () => {
  expect(destinationOf([{ id: "tagging", sends: [], services: [] }], "tagging")).toEqual({
    where: "local",
  });
  expect(destinationOf([], "tagging")).toEqual({ where: "local" });
});

test("the flow's service is named, with whether the User allowed it", () => {
  expect(destinationOf([sent("accepted")], "tagging")).toEqual({
    where: "cloud",
    service,
    allowed: true,
  });
  expect(destinationOf([sent("declined")], "tagging")).toEqual({
    where: "cloud",
    service,
    allowed: false,
  });
  expect(destinationOf([sent("not-asked")], "tagging")).toEqual({
    where: "cloud",
    service,
    allowed: false,
  });
});

test("a flow list that fails is reported and leaves where it sends not known", async () => {
  const failure = new Error("the flows couldn't be read");
  const reported: unknown[] = [];
  await expect(
    destinationFrom(
      () => Promise.reject(failure),
      "tagging",
      (error) => reported.push(error),
    ),
  ).resolves.toEqual({ where: "unknown" });
  expect(reported).toEqual([failure]);
});
