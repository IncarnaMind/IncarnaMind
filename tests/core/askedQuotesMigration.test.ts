/**
 * Migration 105 (#101): a Question in a conversation keeps the words the User selected in
 * Documents to ask about. Questions asked before it have none.
 */
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { DATABASE_FILE } from "../../src/core";
import { migrate, openDatabase } from "../../src/core/storage";
import { migrations } from "../../src/core/storage/migrations";
import { createTempDataFolder, startCore } from "../helpers/core";

const CONVERSATION = "0b6f4c2e-7d1a-4e3b-9a5c-8f2d1e0c3b4a";
const QUESTION = "5a9e8d7c-6b5a-4f3e-8d2c-1b0a9f8e7d6c";
const ANSWER = "c3d2e1f0-a9b8-4c7d-8e6f-5a4b3c2d1e0f";
const AT = "2026-10-01T09:00:00.000Z";

describe("Migration 105: a Question keeps the words it asked about", () => {
  test("a Question asked before reads as asked about none, its Answer as it was", async () => {
    const dataDir = await createTempDataFolder();
    const db = openDatabase(join(dataDir, DATABASE_FILE));
    migrate(
      db,
      migrations.filter((each) => each.version <= 104),
    );
    db.run(
      "INSERT INTO conversations (id, auto_title, created_at, updated_at) VALUES (?, ?, ?, ?)",
      [CONVERSATION, "Spring tides", AT, AT],
    );
    db.run(
      `INSERT INTO conversation_messages
         (id, conversation_id, position, kind, question_id, text, status, created_at, updated_at)
       VALUES (?, ?, 1, 'question', NULL, ?, NULL, ?, ?), (?, ?, 2, 'answer', ?, ?, 'done', ?, ?)`,
      [
        QUESTION,
        CONVERSATION,
        "When are spring tides?",
        AT,
        AT,
        ANSWER,
        CONVERSATION,
        QUESTION,
        "At new and full moon.",
        AT,
        AT,
      ],
    );
    db.close();

    const core = startCore(dataDir);
    const { messages } = await core.getConversation(CONVERSATION);

    expect(messages).toMatchObject([
      { kind: "question", text: "When are spring tides?", quotes: [] },
      { kind: "answer", text: "At new and full moon.", status: "done" },
    ]);
  });
});
