/**
 * Automatic can resolve to another service between a check and the request (#2308): tagging asks
 * whether a Document may go by itself on the service its prepared request resolved to, right
 * before it sends. Through the tagger's own interface, with a scripted model, since the core
 * keeps Automatic's pick steady across one request.
 */
import { randomUUID } from "node:crypto";
import { describe, expect, test } from "vitest";
import type { ExternalService } from "../../src/core/api";
import { createBackgroundQueue } from "../../src/core/backgroundQueue";
import { migrate, openDatabase } from "../../src/core/storage";
import { createTags } from "../../src/core/tags";
import type { TagClassifier } from "../../src/core/tags/classify";
import { createTagger } from "../../src/core/tags/tagger";

const ANTHROPIC: ExternalService = { id: "https://api.anthropic.com", name: "Anthropic" };
const OPENAI: ExternalService = { id: "https://api.openai.com", name: "OpenAI" };

describe("The service a tagging request resolves to", () => {
  test("is the one checked: a request that resolves to OpenAI, never turned on, sends nothing", async () => {
    const db = openDatabase(":memory:");
    migrate(db);
    const now = () => new Date().toISOString();
    const tags = createTags(db, now);
    tags.seedPresets("en");
    const id = randomUUID();
    db.run(
      `INSERT INTO documents (id, content_hash, name, kind, size, status, created_at, updated_at)
       VALUES (?, ?, 'Report', 'text', 1, 'ready', ?, ?)`,
      [id, randomUUID(), now(), now()],
    );
    const sent: string[] = [];
    const asked: (string | undefined)[] = [];
    // Turned on for Anthropic only; before a request is prepared, Anthropic is where tagging sent.
    const classifier: TagClassifier = {
      service: OPENAI,
      decide: async () => {
        sent.push("openai");
        return { decisions: [], newTags: [] };
      },
    };
    let settled = () => {};
    const done = new Promise<void>((resolve) => {
      settled = resolve;
    });
    const tagger = createTagger({
      db,
      now,
      tags,
      background: createBackgroundQueue({
        reportError: (error) => {
          throw error;
        },
      }),
      maySend: (_document: string, service?: ExternalService) => {
        asked.push(service?.id);
        return (service ?? ANTHROPIC).id === ANTHROPIC.id;
      },
      stopped: () => false,
      canRun: async () => true,
      mightBeReady: () => true,
      prepare: async () => classifier,
      announce: () => settled(),
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
    await done;
    await new Promise((resolve) => setImmediate(resolve));

    expect(sent).toEqual([]);
    expect(asked).toEqual([OPENAI.id]);
    expect(
      db.get<{ tagging_status: string }>("SELECT tagging_status FROM documents WHERE id = ?", [id])
        ?.tagging_status,
    ).toBe("off");
  });
});
