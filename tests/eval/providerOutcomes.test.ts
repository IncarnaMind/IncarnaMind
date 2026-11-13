/**
 * Rule 1 of #2847's gate, as the evaluation records it: what the provider answered each request,
 * from the request's own status, and which pairs that leaves out to be pressed again.
 */
import { APICallError } from "ai";
import { describe, expect, test } from "vitest";
import { byProvider, outcomeOf, providerOutcomes } from "../../eval/lib/providerOutcomes";
import type { ArmRun } from "../../eval/speed/paired";
import { leftByProvider, type PairedRow } from "../../eval/speed/pairedReport";
import { scriptedModel } from "../helpers/models";

const refused = (statusCode: number | undefined) =>
  new APICallError({
    message: "Refused.",
    url: "https://api.example.com/v1/messages",
    requestBodyValues: {},
    ...(statusCode !== undefined && { statusCode }),
  });

describe("what the provider answered a request", () => {
  // protects=a request's outcome is read from its own status: a rate limit, an overload, a server error, a refusal, a timeout or a network failure is the provider's, a Stop is the app's and any other error is no provider's; fails_when=one is read as another; no_claim=which errors a provider sends.
  test("from its status", () => {
    expect(
      [429, 529, 503, 400, 408, undefined].map((status) => outcomeOf(refused(status))),
    ).toEqual([
      "rate limited",
      "overloaded",
      "server error 503",
      "refused 400",
      "timeout",
      "network failure",
    ]);
    expect(outcomeOf({ type: "overloaded_error", message: "Overloaded" })).toBe("overloaded");
    expect(outcomeOf(new DOMException("Timed out.", "TimeoutError"))).toBe("timeout");
    expect(outcomeOf(new DOMException("Stopped.", "AbortError"))).toBe("stopped");
    expect(outcomeOf(new TypeError("fetch failed"))).toBe("network failure");
    expect(outcomeOf(new Error("The reply was cut off."))).toBe("failed");
    expect(
      ["rate limited", "network failure", "finished", "stopped", "failed"].map(byProvider),
    ).toEqual([true, true, false, false, false]);
  });

  // protects=each request a wrapped model sends keeps its outcome, a finished stream as finished and one the provider refused by its status; fails_when=an outcome is lost or read otherwise; no_claim=how a real provider streams.
  test("kept for each request sent", async () => {
    let call = 0;
    const model = scriptedModel(() =>
      call++ === 0 ? { text: "Fine." } : { error: { status: 429, message: "Slow down." } },
    );
    const outcomes = providerOutcomes();
    const wrapped = outcomes.wrap(model, "app");
    const options = {
      prompt: [{ role: "user" as const, content: [{ type: "text" as const, text: "Hi" }] }],
    };
    const { stream } = await wrapped.doStream(options);
    for await (const _ of stream) {
      // read to its end
    }
    await expect(wrapped.doStream(options)).rejects.toThrow();
    expect(outcomes.take()).toEqual([
      { kind: "app", outcome: "finished" },
      { kind: "app", outcome: "rate limited" },
    ]);
  });
});

describe("which pairs a provider's outcome leaves out", () => {
  const run = (outcomes: ArmRun["outcomes"], status: ArmRun["status"] = "done") =>
    ({ status, outcomes }) as ArmRun;
  const row = (id: string, baseline: ArmRun, candidate: ArmRun, again?: true) =>
    ({ id, baseline, candidate, ...(again && { again }) }) as PairedRow;

  // protects=only a pair one of whose requests the provider failed is left out to be pressed again, whichever arm sent it, the judge's included; a press the app itself failed stays in, and a pair pressed again isn't pressed a third time; fails_when=an app failure is left out, a provider's isn't, or a pressed-again pair is left out again; no_claim=how often a provider fails.
  test("only the provider's", () => {
    const finished = [{ kind: "app" as const, outcome: "finished" }];
    const rows = [
      row("clean", run(finished), run(finished)),
      row(
        "main overloaded",
        run([{ kind: "app", outcome: "overloaded" }], "failed"),
        run(finished),
      ),
      row(
        "judge timed out",
        run(finished),
        run([...finished, { kind: "judge", outcome: "timeout" }]),
      ),
      row("the app failed", run(finished), run([{ kind: "app", outcome: "finished" }], "failed")),
      row("pressed again", run([{ kind: "app", outcome: "rate limited" }]), run(finished), true),
    ];
    expect(leftByProvider(rows).map((each) => each.id)).toEqual([
      "main overloaded",
      "judge timed out",
    ]);
  });
});
