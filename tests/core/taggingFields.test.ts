/**
 * What tagging sends, traced to what the tagging flow says it sends (#2339, ADR-0022): every field
 * of every request tagging builds is listed in `TAGGING_FIELDS` with the kinds of data it holds,
 * each of them the flow's own or the app's. A request that starts carrying something new fails
 * here until it is listed. The instructions and the app's own fields carry nothing of the User's.
 */
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, test } from "vitest";
import type { Core } from "../../src/core";
import type { ChatModelSpec } from "../../src/core/providers/models";
import {
  chatClassifier,
  type DocumentExcerpt,
  kindDefinitions,
} from "../../src/core/tags/classify";
import { decisionModelTagger, tagQuestions } from "../../src/core/tags/jev";
import { TAG_KINDS } from "../../src/core/tags/kinds";
import { TAGGING_FLOW_SENDS } from "../../src/core/tags/tagger";
import { TAGGING_FIELDS } from "../../src/core/tags/taggingFields";
import { createTempDataFolder, startCore } from "../helpers/core";
import { addAndProcess, createSourceFolder, writeSourceFile } from "../helpers/documents";
import { startFakeJev } from "../helpers/jev";
import { waitForTagging } from "../helpers/tags";

type CallOptions = Parameters<MockLanguageModelV4["doGenerate"]>[0];

/** The User's own words in the requests below: none may reach the instructions or the app's fields. */
const THEIRS = ["Zephyr", "Kestrel", "Osprey", "Heron", "Plover"];

/** A key a request makes from an id (a Tag's or a kind's): one field for all. */
const KEYED = /^(t-|kind:|[0-9a-f]{8}-[0-9a-f]{4}-)/;

function fieldsOf(request: string, value: unknown, into: Map<string, unknown[]>) {
  const walk = (at: unknown, path: string) => {
    if (Array.isArray(at)) {
      for (const item of at) walk(item, `${path}[]`);
      return;
    }
    if (at !== null && typeof at === "object") {
      for (const [key, inner] of Object.entries(at))
        walk(inner, `${path}.${KEYED.test(key) ? "*" : key}`);
      return;
    }
    into.set(path, [...(into.get(path) ?? []), at]);
  };
  walk(value, request);
  return into;
}

/** A chat model answering each tagging request with no kind and no Tag, keeping its fields. */
function recording() {
  const fields = new Map<string, unknown[]>();
  const instructions: string[] = [];
  const answer = (sent: { documents?: { ref: string }[] }) => ({
    tagged: (sent.documents ?? []).map(({ ref }) => ({
      ref,
      kind: "none",
      tags: [],
      topic: { name: "", description: "" },
    })),
  });
  const model = new MockLanguageModelV4({
    doGenerate: async (options: CallOptions) => {
      const named = options.responseFormat?.type === "json" ? options.responseFormat.name : "";
      let sent: { documents?: { ref: string }[] } = {};
      for (const message of options.prompt) {
        if (message.role === "system") instructions.push(message.content);
        if (message.role !== "user") continue;
        for (const part of message.content)
          if (part.type === "text") {
            sent = JSON.parse(part.text);
            fieldsOf(named === "document_tags" ? "chat" : `other:${named}`, sent, fields);
          }
      }
      return {
        content: [{ type: "text", text: JSON.stringify(answer(sent)) }],
        finishReason: { unified: "stop", raw: undefined },
        warnings: [],
        usage: {
          inputTokens: { total: 5, noCache: 5, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: 1, text: 1, reasoning: undefined },
        },
      };
    },
  });
  return { model, fields, instructions };
}

const unlisted = (fields: Map<string, unknown[]>) =>
  [...fields.keys()].filter((path) => !(path in TAGGING_FIELDS));

/** The fields that hold only the app's own, whose values carry any of the User's words. */
const leaked = (fields: Map<string, unknown[]>) =>
  [...fields].filter(
    ([path, values]) =>
      TAGGING_FIELDS[path]?.every((kind) => kind === "app") &&
      values.some((value) => THEIRS.some((word) => String(value).includes(word))),
  );

const theirsIn = (texts: readonly string[]) =>
  texts.filter((text) => THEIRS.some((word) => text.includes(word)));

const osprey = { id: "t-osprey", name: "Osprey", description: "Osprey berth notes." };
const excerpt = (name: string): DocumentExcerpt => ({
  name,
  kind: "pdf",
  pageCount: 2,
  text: "Zephyr quay depth was low in March; Kestrel and Heron berths were dredged.",
});

describe("Every request tagging builds carries only what the tagging flow says it sends (#2339)", () => {
  // protects=each field of the chat model's request for one Document and for several, and of a decision host's, is listed with its kinds, and the list holds no field none of them carries; fails_when=a request carries a field the list doesn't name, or the list keeps one no request sends; no_claim=what the model answers.
  test("each request's fields are the listed ones, no more and no fewer", async () => {
    const chat = recording();
    const signal = new AbortController().signal;
    const tagger = chatClassifier(chat.model);
    await tagger.decide({
      tags: [...kindDefinitions(), osprey],
      excerpt: excerpt("Zephyr berth review"),
      signal,
    });
    await tagger.decideMany?.({
      documents: [
        { ref: "0b6c7d2e-1111-4222-8333-944455556666", excerpt: excerpt("Zephyr"), tags: [osprey] },
        { ref: "0b6c7d2e-1111-4222-8333-944455557777", excerpt: excerpt("Plover"), tags: [] },
      ],
      kinds: TAG_KINDS,
      language: "zh-CN",
      signal,
    });
    const jev = await startFakeJev({ apiKey: "ollama" });
    await decisionModelTagger({ baseUrl: jev.url, model: "jev-1" }).decide({
      tags: [...kindDefinitions(), osprey],
      excerpt: excerpt("Zephyr berth review"),
      signal,
    });
    const fields = chat.fields;
    for (const request of jev.requests) fieldsOf("decision", request.body, fields);
    // A host that takes a question only with what a no means too.
    fieldsOf("decision", { questions: tagQuestions([osprey], true) }, fields);

    expect(unlisted(fields)).toEqual([]);
    expect(Object.keys(TAGGING_FIELDS).filter((path) => !fields.has(path))).toEqual([]);
    expect(leaked(fields)).toEqual([]);
    expect(theirsIn(chat.instructions)).toEqual([]);
    const kinds = new Set(Object.values(TAGGING_FIELDS).flat());
    expect([...kinds].filter((kind) => kind !== "app").sort()).toEqual(
      [...TAGGING_FLOW_SENDS].sort(),
    );
  });

  // protects=tagging a new Document in the background and a Re-tag the User runs, as the core makes them from stored Documents and the User's own Tags, send only listed fields; fails_when=the tagger, the Re-tag run or what they read of a Document adds a field to what they send; no_claim=what is proposed.
  test("the core's own runs send only the listed fields", async () => {
    const chat = recording();
    const core: Core = startCore(await createTempDataFolder(), {
      createChatModel: (_spec: ChatModelSpec) => chat.model,
    });
    await core.saveChatProvider({
      kind: "anthropic",
      apiKey: "sk-ant-test",
      modelId: "claude-haiku-5-5",
    });
    const { settings } = await core.getLibrary();
    await core.saveLibrarySettings({ ...settings, turnOn: true });
    await core.createTag({ name: "Kestrel quay", description: "Zephyr quay works." });
    const sources = await createSourceFolder();
    const paths = await Promise.all(
      [1, 2, 3].map((index) =>
        writeSourceFile(
          sources,
          `Zephyr ${index}.md`,
          `# Zephyr ${index}\n\nThe Kestrel quay works were low.`,
        ),
      ),
    );
    const documents = await addAndProcess(core, paths);
    await waitForTagging(
      core,
      documents.map((each) => each.id),
    );
    const background = new Map(chat.fields);
    await core.tagDocuments({ documentIds: documents.map((each) => each.id) });

    expect(background.has("chat.tags[].name")).toBe(true);
    expect(chat.fields.get("chat.documents[].ref")?.length).toBeGreaterThan(
      background.get("chat.documents[].ref")?.length ?? 0,
    );
    expect(unlisted(chat.fields)).toEqual([]);
    expect(leaked(chat.fields)).toEqual([]);
    expect(theirsIn(chat.instructions)).toEqual([]);
  });
});
