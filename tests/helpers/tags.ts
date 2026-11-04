import { MockLanguageModelV4 } from "ai/test";
import type { Core, Document, Tag } from "../../src/core";

type CallOptions = Parameters<MockLanguageModelV4["doGenerate"]>[0];

/** What one tagging request sent, simplified. */
export interface TaggingRequest {
  /** The instructions and the prompt, as text. */
  text: string;
  /** The Tag names the structured output may choose from. */
  names: string[];
  /** Whether the request asked for JSON (structured output). */
  json: boolean;
}

export interface TaggingModel {
  model: MockLanguageModelV4;
  /** Every request, in order. */
  readonly requests: TaggingRequest[];
  /** What the model chooses from now on. */
  choose(names: readonly string[] | ((request: TaggingRequest) => string[])): void;
  /** The new Tags the model names from now on, beside those it chooses. */
  name(
    tags:
      | readonly { name: string; description: string }[]
      | ((request: TaggingRequest) => { name: string; description: string }[]),
  ): void;
  /** Holds every answer until `release()`. */
  hold(): void;
  release(): void;
  /** Resolves once the model has been asked `count` times. */
  requested(count?: number): Promise<void>;
  /** Makes the next answers fail like a provider error. */
  fail(error: Error | null): void;
}

const USAGE = {
  inputTokens: { total: 5, noCache: 5, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
};

function describe(options: CallOptions): TaggingRequest {
  const text = options.prompt
    .map((message) =>
      typeof message.content === "string"
        ? message.content
        : message.content.map((part) => ("text" in part ? part.text : "")).join(""),
    )
    .join("\n");
  const format = options.responseFormat;
  const schema = format?.type === "json" ? format.schema : undefined;
  const tags = (schema?.properties?.tags ?? undefined) as
    | { items?: { enum?: unknown[] } }
    | boolean
    | undefined;
  const names =
    typeof tags === "object" && Array.isArray(tags.items?.enum)
      ? tags.items.enum.filter((name): name is string => typeof name === "string")
      : [];
  return { text, names, json: format?.type === "json" };
}

/**
 * A chat model for automatic tagging: it answers each structured-output
 * request with the Tag names chosen, as JSON, the way a provider does.
 */
export function taggingModel(initial: readonly string[] = []): TaggingModel {
  let choose: (request: TaggingRequest) => string[] = () => [...initial];
  let naming: (request: TaggingRequest) => { name: string; description: string }[] = () => [];
  let gate: Promise<void> | null = null;
  let open = () => {};
  let failure: Error | null = null;
  const requests: TaggingRequest[] = [];
  const waiting: { count: number; resolve: () => void }[] = [];

  const model = new MockLanguageModelV4({
    doGenerate: async (options) => {
      const request = describe(options);
      requests.push(request);
      for (const wait of waiting.filter((each) => each.count <= requests.length)) wait.resolve();
      if (gate) await gate;
      if (failure) throw failure;
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ tags: choose(request), newTags: naming(request) }),
          },
        ],
        finishReason: { unified: "stop", raw: undefined },
        usage: USAGE,
        warnings: [],
      };
    },
  });

  return {
    model,
    requests,
    choose(names) {
      choose = typeof names === "function" ? names : () => [...names];
    },
    name(tags) {
      naming = typeof tags === "function" ? tags : () => [...tags];
    },
    hold() {
      gate = new Promise((resolve) => {
        open = resolve;
      });
    },
    release() {
      gate = null;
      open();
    },
    requested: (count = 1) =>
      requests.length >= count
        ? Promise.resolve()
        : new Promise((resolve) => waiting.push({ count, resolve })),
    fail(error) {
      failure = error;
    },
  };
}

/**
 * Resolves with the Documents, in the order given, once each satisfies
 * `done` (by default: tagged), following "documents.tagged" and
 * "document.status" events.
 */
export function waitForTagging(
  core: Core,
  ids: readonly string[],
  done: (document: Document) => boolean = (document) => document.tagging === "tagged",
  timeout = 15_000,
): Promise<Document[]> {
  return new Promise((resolve, reject) => {
    const wanted = new Set(ids);
    const settled = new Map<string, Document>();
    /** `latest`: from an event, so newer than anything seen; the first listing only adds. */
    const check = (document: Document, latest = true) => {
      if (!wanted.has(document.id)) return;
      if (done(document)) settled.set(document.id, document);
      else if (latest) settled.delete(document.id);
      if (settled.size < wanted.size) return;
      clearTimeout(timer);
      for (const stop of stops) stop();
      resolve(ids.map((id) => settled.get(id) as Document));
    };
    const timer = setTimeout(() => {
      for (const stop of stops) stop();
      reject(new Error(`Tagging didn't settle within ${timeout} ms.`));
    }, timeout);
    const stops = [
      core.on("documents.tagged", (documents) => {
        for (const document of documents) check(document);
      }),
      core.on("document.status", (document) => check(document)),
    ];
    void core.listDocuments().then((documents) => {
      for (const document of documents) check(document, false);
    }, reject);
  });
}

/** The Tag with this name. */
export async function tagNamed(core: Core, name: string): Promise<Tag> {
  const tag = (await core.listTags()).find((each) => each.name === name);
  if (!tag) throw new Error(`There is no Tag named ${name}.`);
  return tag;
}

/** The names of a Document's Tags, as the core lists them now. */
export async function tagNamesOf(core: Core, documentId: string): Promise<string[]> {
  const [tags, documents] = await Promise.all([core.listTags(), core.listDocuments()]);
  const document = documents.find((each) => each.id === documentId);
  if (!document) throw new Error("No such Document.");
  return document.tags.map((link) => tags.find((tag) => tag.id === link.tagId)?.name ?? "?");
}
