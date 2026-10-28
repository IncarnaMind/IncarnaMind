import { expect, test } from "vitest";
import * as Y from "yjs";
import type { ClaimCheckResult } from "../../src/core";
import { runChecks } from "../../src/core/answers/checks/runChecks";
import type { PreparedChatModel } from "../../src/core/providers/chat";
import { nextTurn } from "../helpers/core";

const supported: ClaimCheckResult = {
  verdict: "supported",
  evidence: null,
  says: null,
  unsupported: null,
  calculation: null,
  citedCaseUnchecked: false,
  citedCaseFound: false,
  versions: [],
  excluded: [],
  recordCites: [],
};

test.each([
  { kind: "direct record cites", second: "Dkt. 41 at 2 states another deadline." },
  { kind: "Id./supra references", second: "Id. at 2 states another deadline." },
])("a cloud run starts $kind without waiting for stored referents", async ({ second }) => {
  const first = "ECF No. 41 at 3 states the deadline.";
  const calls: string[] = [];
  let release: (() => void) | undefined;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  const prepared = {
    provider: { id: "cloud", service: { id: "anthropic" } },
    modelId: "test-model",
  } as unknown as PreparedChatModel;
  const run = runChecks(
    {
      content: { edit: (_mindId, change) => change(new Y.XmlFragment()) },
      claimCheck: async ({ claim }) => {
        calls.push(claim);
        if (claim === first) await waiting;
        return supported;
      },
      withResult: (check) => check,
      retainEvidence: () => undefined,
      recordAiUse: () => undefined,
      now: () => new Date("2026-10-27T00:00:00.000Z"),
    },
    {
      mindId: "mind-1",
      queued: [
        { id: "first", claim: first, context: first },
        { id: "second", claim: second, context: second },
      ],
      scope: { documentIds: null, excluded: new Map() },
      prepared,
      signal: new AbortController().signal,
    },
  );

  await nextTurn();
  expect(calls).toEqual([first, second]);
  if (!release) throw new Error("The first check did not start.");
  release();
  await run;
  expect(calls).toEqual([first, second]);
});
