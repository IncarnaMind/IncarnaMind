import { writeFile } from "node:fs/promises";
import { expect, test } from "vitest";
import { checkGenerate, checkReply, isCheckRun } from "../helpers/checks";
import { setUpWithDocuments } from "../helpers/citations";
import { queryDatabase, startCore } from "../helpers/core";
import { sha256, waitForProcessing } from "../helpers/documents";
import { scriptedModel } from "../helpers/models";

const CLAIM = "Revenue was $1,200 million.";
const QUOTE = "Revenue was $1,482.6 million.";
const V2 = "Revenue was $1,500.0 million.";

test("a background check's evidence version survives the next start", async () => {
  const plans = { [CLAIM]: { verdict: "contradicted" as const, quote: QUOTE } };
  const model = scriptedModel(
    (call) => (isCheckRun(call) ? checkReply(call, plans) : { text: CLAIM }),
    { generate: checkGenerate(plans) },
  );
  const { core, dataDir, documents } = await setUpWithDocuments(model, [
    { name: "Report.md", contents: QUOTE },
  ]);
  const document = documents[0];
  if (!document) throw new Error("No Report.");
  const ended = new Promise<void>((resolve) => core.on("answer.finished", () => resolve()));
  const asked = await core.askInConversation({ text: "What was revenue?" });
  if (!asked.asked) throw new Error("The Question wasn't asked.");
  await ended;
  const { messages } = await core.getConversation(asked.conversation.id);
  const answer = messages.find((message) => message.kind === "answer");
  expect(answer?.kind).toBe("answer");
  if (answer?.kind !== "answer") throw new Error("No such Answer.");
  expect(answer.claimChecks?.[0]?.evidence?.contentHash).toBe(sha256(QUOTE));

  await writeFile(document.path, V2);
  await core.reconcileDocuments();
  await waitForProcessing(core, [document.id]);
  const count = () =>
    queryDatabase<{ n: number }>(
      dataDir,
      "SELECT count(*) AS n FROM passages WHERE content_hash = ?",
      [sha256(QUOTE)],
    )[0]?.n;
  core.close();
  startCore(dataDir);
  expect(count()).toBeGreaterThan(0);
});

test("an Unsupported result's quoted evidence version survives the next start", async () => {
  const plans = {
    [CLAIM]: {
      verdict: "unsupported" as const,
      quote: QUOTE,
      judgement: "same" as const,
      says: "The report gives another figure.\nCovered: revenue\nNot covered: the claimed amount",
    },
  };
  const model = scriptedModel(
    (call) => (isCheckRun(call) ? checkReply(call, plans) : { text: CLAIM }),
    { generate: checkGenerate(plans) },
  );
  const { core, dataDir, documents } = await setUpWithDocuments(model, [
    { name: "Report.md", contents: QUOTE },
  ]);
  const document = documents[0];
  if (!document) throw new Error("No Report.");
  const ended = new Promise<void>((resolve) => core.on("answer.finished", () => resolve()));
  const asked = await core.askInConversation({ text: "What was revenue?" });
  if (!asked.asked) throw new Error("The Question wasn't asked.");
  await ended;
  const { messages } = await core.getConversation(asked.conversation.id);
  const answer = messages.find((message) => message.kind === "answer");
  if (answer?.kind !== "answer") throw new Error("No such Answer.");
  expect(answer.claimChecks?.[0]?.evidence).toBeNull();
  expect(answer.claimChecks?.[0]?.unsupported?.quoted?.contentHash).toBe(sha256(QUOTE));

  await writeFile(document.path, V2);
  await core.reconcileDocuments();
  await waitForProcessing(core, [document.id]);
  const count = () =>
    queryDatabase<{ n: number }>(
      dataDir,
      "SELECT count(*) AS n FROM passages WHERE content_hash = ?",
      [sha256(QUOTE)],
    )[0]?.n;
  core.close();
  startCore(dataDir);
  expect(count()).toBeGreaterThan(0);
});
