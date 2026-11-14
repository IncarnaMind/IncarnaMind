/**
 * A failed Answer keeps which part of it was too long, when it wasn't the Question (#3045): text
 * selected in a Note, too long to go whole at a small window. Live and after a restart its line
 * asks for less of it; an Answer that failed before the column existed, or with a part this build
 * doesn't know, reads as none and keeps today's too-long line. The upgrade is found by what it
 * does, not its number, which is set when it merges.
 */
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { type Core, DATABASE_FILE } from "../../src/core";
import type { ConversationAnswer } from "../../src/core/api";
import { createOllamaModels } from "../../src/core/providers/ollamaModels";
import { openDatabase } from "../../src/core/storage";
import { migrations } from "../../src/core/storage/migrations";
import { failedAnswerLine } from "../../src/renderer/src/problems";
import { answerEnded } from "../helpers/citations";
import { createTempDataFolder, startCore } from "../helpers/core";
import { addAndProcess, writeSourceFile } from "../helpers/documents";
import { GIB, QWEN35_9B, TIDES } from "../helpers/localModels";
import { connectToMind } from "../helpers/mindClient";
import { note, writeMind } from "../helpers/minds";
import { startOllamaServer } from "../helpers/ollama";
import { waitForTagging } from "../helpers/tags";

const upgrade = migrations.find((each) =>
  each.description.startsWith("A failed Answer keeps which part of it was too long"),
);

/** A core on `dataDir` with the app's own Ollama lookups on a 32 GB computer: a 16k window. */
const coreOn = (dataDir: string) =>
  startCore(dataDir, {
    createChatModel: undefined,
    ollamaModels: createOllamaModels({ memoryBytes: () => 32 * GIB }),
  });

/** Asks the assistant at 16k about a selection of `words` words; the failed Answer as stored. */
async function askedAboutSelection(words: number) {
  const ollama = await startOllamaServer({
    models: [QWEN35_9B],
    reply: () => ({ content: JSON.stringify({ tags: [] }) }),
  });
  const dataDir = await createTempDataFolder();
  const core = coreOn(dataDir);
  await core.saveChatProvider({ kind: "ollama", baseUrl: ollama.baseUrl, modelId: QWEN35_9B.name });
  const sources = await createTempDataFolder();
  const added = await addAndProcess(core, [await writeSourceFile(sources, "Tides.md", TIDES)]);
  await waitForTagging(
    core,
    added.map((document) => document.id),
    (document) => document.tagging !== "pending" && document.tagging !== "tagging",
  );
  const mind = await core.createMind({ title: "Tides" });
  const client = await connectToMind(core, mind.id);
  const selection = Array.from({ length: words }, (_, at) => `berth${at % 9}`).join(" ");
  const selected = note(selection);
  writeMind(client, [selected]);
  await client.settled();
  const asked = await core.askInConversation({
    text: "Make this shorter.",
    mindId: mind.id,
    focus: { selection, blockIds: [String(selected.attrs?.id)] },
  });
  if (!asked.asked) throw new Error("Not asked.");
  await answerEnded(core, asked.answerId);
  return { dataDir, core, conversationId: asked.conversation.id };
}

async function failedAnswer(core: Core, conversationId: string): Promise<ConversationAnswer> {
  const { messages } = await core.getConversation(conversationId);
  const answer = messages.find((message) => message.kind === "answer");
  if (answer?.kind !== "answer") throw new Error("No Answer.");
  return answer;
}

/** The line the assistant shows for it, as `AssistantAnswer` asks for it of a model on this computer. */
const lineOf = (answer: ConversationAnswer) => {
  const shown = failedAnswerLine(answer.errorKind ?? "unknown", "ollama", null, false, {
    local: true,
    asked: "assistant",
    ...(answer.errorTooLong && { tooLong: answer.errorTooLong }),
  });
  return shown.kind === "plain" ? shown.problem.line : null;
};

/** Changes the stored Answer's database as `change` says, with the core closed. */
function withDatabase(dataDir: string, change: (db: ReturnType<typeof openDatabase>) => void) {
  const db = openDatabase(join(dataDir, DATABASE_FILE));
  try {
    change(db);
  } finally {
    db.close();
  }
}

describe("A failed Answer keeps which part of it was too long (#3045)", { timeout: 60_000 }, () => {
  // protects=a selection too long to go with the Question is kept with the failed Answer, so its line asks for less of it live and after the core starts again on the same data folder; fails_when=the part is lost on the way, or after the restart the line is the Question's; no_claim=when a selection is too long, which tests/core/smallWindow.test.ts pins.
  test("the selection's part is kept, live and after a restart", async () => {
    const { dataDir, core, conversationId } = await askedAboutSelection(1_500);
    const live = await failedAnswer(core, conversationId);
    expect(live).toMatchObject({
      status: "failed",
      errorKind: "too-long",
      errorTooLong: "selection",
    });
    expect(lineOf(live)).toBe("answer.error.too-long.selection");
    core.close();

    const again = coreOn(dataDir);
    const stored = await failedAnswer(again, conversationId);
    expect(stored).toMatchObject({ errorKind: "too-long", errorTooLong: "selection" });
    expect(lineOf(stored)).toBe("answer.error.too-long.selection");
    again.close();
  });

  // protects=the upgrade adds the column and leaves every Answer stored before it as it was: one that failed as too long reads with no part, and shows today's line; fails_when=the upgrade fails on a database with conversations, or an older failure reads as the selection's; no_claim=none beyond protects.
  test("an Answer stored before the upgrade reads with no part, and keeps today's line", async () => {
    if (!upgrade) throw new Error("The upgrade isn't in the list.");
    const { dataDir, core, conversationId } = await askedAboutSelection(1_500);
    core.close();
    // The database as the version before the upgrade left it: no column, the upgrade not applied.
    withDatabase(dataDir, (db) => {
      db.exec("ALTER TABLE conversation_messages DROP COLUMN error_too_long");
      db.run("DELETE FROM schema_migrations WHERE version = ?", [upgrade.version]);
    });

    const upgraded = coreOn(dataDir);
    const stored = await failedAnswer(upgraded, conversationId);
    expect(stored).toMatchObject({ status: "failed", errorKind: "too-long", errorTooLong: null });
    expect(lineOf(stored)).toBe("answer.error.too-long");
    upgraded.close();
    withDatabase(dataDir, (db) => {
      expect(
        db.get<{ n: number }>(
          "SELECT count(*) AS n FROM conversation_messages WHERE error_too_long IS NOT NULL",
        )?.n,
      ).toBe(0);
    });
  });

  // protects=a part this build doesn't know, which a later build may store, reads as none: today's line, never a failure to read the conversation; fails_when=it throws or reads as the selection's; no_claim=what a later build stores.
  test("a part this build doesn't know reads as none", async () => {
    const { dataDir, core, conversationId } = await askedAboutSelection(1_500);
    core.close();
    withDatabase(dataDir, (db) => {
      db.run("UPDATE conversation_messages SET error_too_long = 'figure' WHERE kind = 'answer'");
    });

    const again = coreOn(dataDir);
    const stored = await failedAnswer(again, conversationId);
    expect(stored).toMatchObject({ errorKind: "too-long", errorTooLong: null });
    expect(lineOf(stored)).toBe("answer.error.too-long");
    again.close();
  });
});
