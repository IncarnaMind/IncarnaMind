/**
 * With every kind withdrawn and none of the User's own Tags to offer, tagging sends nothing and a
 * Document is "no-tags", so it is checked once a Tag exists (#1129, #2339). Through the tagger's
 * own interface, since a fresh Library always has kinds to offer.
 */
import { randomUUID } from "node:crypto";
import { describe, expect, test } from "vitest";
import { createBackgroundQueue } from "../../src/core/backgroundQueue";
import { migrate, openDatabase } from "../../src/core/storage";
import type { TagClassifier, TagDefinition } from "../../src/core/tags/classify";
import { createTagger } from "../../src/core/tags/tagger";

describe("Tagging with nothing to offer", () => {
  test("sends nothing, and the Document is tagged once a Tag exists", async () => {
    const db = openDatabase(":memory:");
    migrate(db);
    const now = () => new Date().toISOString();
    const id = randomUUID();
    db.run(
      `INSERT INTO documents (id, content_hash, name, kind, size, status, created_at, updated_at)
       VALUES (?, ?, 'Harbour dues', 'text', 1, 'ready', ?, ?)`,
      [id, randomUUID(), now(), now()],
    );
    const statusOf = () =>
      db.get<{ tagging_status: string }>("SELECT tagging_status FROM documents WHERE id = ?", [id])
        ?.tagging_status;
    const asked: string[][] = [];
    const classifier: TagClassifier = {
      decide: async ({ tags }) => {
        asked.push(tags.map((tag) => tag.name));
        return { decisions: [], newTags: [] };
      },
    };
    let own: TagDefinition[] = [];
    let announced = () => {};
    const tagger = createTagger({
      db,
      now,
      offered: () => own,
      kinds: () => [],
      language: () => "en",
      propose: () => {},
      background: createBackgroundQueue({
        reportError: (error) => {
          throw error;
        },
      }),
      maySend: () => true,
      stopped: () => false,
      canRun: async () => true,
      mightBeReady: () => true,
      prepare: async () => classifier,
      announce: () => announced(),
      reportError: (error) => {
        throw error;
      },
      rateLimit: {
        pausedUntil: () => null,
        pause: () => null,
        succeeded: () => {},
        refusal: () => null,
        refuse: () => null,
      },
      timers: { now: () => 0, sleep: async () => {} },
    });
    const settles = (status: string) =>
      new Promise<void>((resolve) => {
        announced = () => {
          if (statusOf() === status) resolve();
        };
      });

    const unchecked = settles("no-tags");
    tagger.start();
    await unchecked;
    expect(asked).toEqual([]);

    own = [{ id: "t-dues", name: "Harbour dues", description: "What the harbour charges." }];
    const checked = settles("tagged");
    tagger.tagsDefined();
    await checked;
    expect(asked).toEqual([["Harbour dues"]]);
  });
});
