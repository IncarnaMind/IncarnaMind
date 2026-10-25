import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { type Core, DATABASE_FILE } from "../../src/core";
import { openDatabase } from "../../src/core/storage";
import { answerEnded, setUpWithDocuments } from "../helpers/citations";
import { startCore } from "../helpers/core";
import { scriptedModel } from "../helpers/models";

const MEMO = "The quarterly memo says shipping costs rose in the north.";
const HANDBOOK = "Chapter 7 on risk: escalate any incident rated high to the duty manager.";

/** A model that searches once, then says what a model that found nothing says. */
const searching = () => {
  const results: string[] = [];
  const systems: string[] = [];
  const model = scriptedModel((call) => {
    systems.push(call.system);
    const [found] = call.results;
    if (!found) return { calls: [{ tool: "search_documents", input: { query: "escalation" } }] };
    results.push(found.text);
    return { text: "I couldn’t find a handbook in your Documents." };
  });
  return { model, results, systems };
};

/** Puts a Document's status where a read still under way has it, from outside the core, as the reading itself would. */
function setStatus(dataDir: string, id: string, status: "queued" | "extracting" | "ready") {
  const db = openDatabase(join(dataDir, DATABASE_FILE));
  try {
    db.run("UPDATE documents SET status = ? WHERE id = ?", [status, id]);
  } finally {
    db.close();
  }
}

async function ask(core: Core, text: string) {
  const asked = await core.askInConversation({ text });
  if (!asked.asked) throw new Error(`The Question wasn't asked: ${JSON.stringify(asked)}`);
  await answerEnded(core, asked.answerId);
  const content = await core.getConversation(asked.conversation.id);
  const answer = content.messages.find((message) => message.id === asked.answerId);
  if (answer?.kind !== "answer") throw new Error("No Answer.");
  return answer;
}

describe("A Document still being read (#1503)", { timeout: 60_000 }, () => {
  // protects=an Answer written while a Document of its scope is Queued or Extracting says so, in the search's result for the model and as a line the Answer keeps; fails_when=the model is never told, or the Answer keeps nothing, so a Document still being read reads as missing; no_claim=what the model then writes.
  test("the model is told it is still being read, and the Answer keeps the one Document, then none once it is ready", async () => {
    const { model, results, systems } = searching();
    const { core, dataDir, documents } = await setUpWithDocuments(model, [
      { name: "Memo.md", contents: MEMO },
      { name: "Handbook.md", contents: HANDBOOK },
    ]);
    const handbook = documents.find((each) => each.name === "Handbook");
    if (!handbook) throw new Error("No Handbook.");

    setStatus(dataDir, handbook.id, "extracting");
    const waiting = await ask(
      core,
      "In the handbook, what does the risk chapter say about escalation?",
    );
    expect(waiting.steps?.stillReading).toEqual({ count: 1, name: "Handbook" });
    expect(results.at(-1)).toContain(
      'IncarnaMind is still reading a Document in the search: "Handbook".',
    );
    expect(results.at(-1)).toContain("Never say it doesn't exist or wasn't added");
    // Also in the instructions, which list only the Documents already read: a model told so alone said the handbook wasn't there.
    expect(systems.at(-1)).toContain(
      'IncarnaMind is still reading a Document in the search: "Handbook".',
    );

    setStatus(dataDir, handbook.id, "ready");
    const ready = await ask(
      core,
      "In the handbook, what does the risk chapter say about escalation?",
    );
    expect(ready.steps?.stillReading).toBeUndefined();
    expect(results.at(-1)).not.toContain("still reading");
    expect(systems.at(-1)).not.toContain("still reading");
  });

  test("several are counted, and queued ones count with extracting ones", async () => {
    const { model, results } = searching();
    const { core, dataDir, documents } = await setUpWithDocuments(model, [
      { name: "Memo.md", contents: MEMO },
      { name: "Handbook.md", contents: HANDBOOK },
      { name: "Policy.md", contents: "Policy notes." },
    ]);
    setStatus(dataDir, documents[1]?.id ?? "", "queued");
    setStatus(dataDir, documents[2]?.id ?? "", "extracting");

    const answer = await ask(core, "What does the handbook say about escalation?");

    expect(answer.steps?.stillReading).toEqual({ count: 2 });
    expect(results.at(-1)).toContain("IncarnaMind is still reading 2 Documents in the search");
  });

  test("the line is kept with the Answer, read back the same after a restart", async () => {
    const { model } = searching();
    const { core, dataDir, documents } = await setUpWithDocuments(model, [
      { name: "Handbook.md", contents: HANDBOOK },
    ]);
    setStatus(dataDir, documents[0]?.id ?? "", "extracting");
    const answer = await ask(core, "What does the handbook say about escalation?");
    expect(answer.steps?.stillReading).toEqual({ count: 1, name: "Handbook" });
    core.close();

    const again = startCore(dataDir);
    const [conversation] = await again.listConversations();
    const content = await again.getConversation(conversation?.id ?? "");
    const kept = content.messages.find((message) => message.kind === "answer");
    expect(kept?.kind === "answer" ? kept.steps?.stillReading : null).toEqual({
      count: 1,
      name: "Handbook",
    });
  });
});
