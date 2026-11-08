/**
 * A Document already here when tagging was turned on is held: it goes only when the User asks
 * (#2308). Their Re-tag can land while a background turn for that Document is still preparing.
 * That turn gives way, and the Re-tag still goes: the turn it gave way to must not take the
 * User's request with it. Through the tagger's own interface, with the prepare step held open.
 */
import { randomUUID } from "node:crypto";
import { expect, test } from "vitest";
import type { ExternalService } from "../../src/core/api";
import { createBackgroundQueue } from "../../src/core/backgroundQueue";
import { migrate, openDatabase } from "../../src/core/storage";
import { createTags } from "../../src/core/tags";
import type { TagClassifier } from "../../src/core/tags/classify";
import { createTagger } from "../../src/core/tags/tagger";

const LIQUID: ExternalService = { id: "https://api.liquid.ai", name: "Liquid AI" };

test("a Re-tag pressed while a held Document's background turn prepares is still sent", async () => {
  const db = openDatabase(":memory:");
  migrate(db);
  const now = () => new Date().toISOString();
  const tags = createTags(db, now);
  tags.seedPresets("en");
  const id = randomUUID();
  db.run(
    `INSERT INTO documents (id, content_hash, name, kind, size, status, created_at, updated_at)
     VALUES (?, ?, 'Attention', 'text', 1, 'ready', ?, ?)`,
    [id, randomUUID(), now(), now()],
  );
  const paper = tags.list().find((tag) => tag.name === "Paper");
  if (!paper) throw new Error("No Paper Tag.");
  let sent = 0;
  const classifier: TagClassifier = {
    service: LIQUID,
    decide: async () => {
      sent += 1;
      return { decisions: [{ tagId: paper.id, confidence: 0.9, needsReview: false }], newTags: [] };
    },
  };
  // The first turn's prepare waits until the Re-tag is in; later ones are at once.
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let prepared = 0;
  let preparing = () => {};
  const firstPrepare = new Promise<void>((resolve) => {
    preparing = resolve;
  });
  const states: string[] = [];
  const tagger = createTagger({
    db,
    now,
    tags,
    automatic: () => true,
    background: createBackgroundQueue({
      reportError: (error) => {
        throw error;
      },
    }),
    // Here before tagging was turned on: it goes by itself to no one.
    maySend: () => false,
    stopped: () => false,
    canRun: async () => true,
    mightBeReady: () => true,
    prepare: async () => {
      prepared += 1;
      if (prepared === 1) {
        preparing();
        await held;
      }
      return classifier;
    },
    announce: () => {
      const row = db.get<{ tagging_status: string }>(
        "SELECT tagging_status FROM documents WHERE id = ?",
        [id],
      );
      if (row) states.push(row.tagging_status);
    },
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

  tagger.start();
  await firstPrepare;
  tagger.retag([id]);
  release();
  await expect
    .poll(
      () =>
        db.get<{ tagging_status: string }>("SELECT tagging_status FROM documents WHERE id = ?", [
          id,
        ])?.tagging_status,
    )
    .toBe("tagged");

  expect(sent).toBe(1);
  expect(states).not.toContain("off");
});
