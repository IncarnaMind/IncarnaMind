/**
 * What Organize sends, traced to what its consent words say (#1569, ADR-0022): every field of
 * every request Organize builds is listed in `ORGANIZE_FIELDS` with the kinds of data it holds,
 * every kind is in `ORGANIZE_SENDS`, and every sentence that asks for that consent names every
 * kind, in English and Chinese. A request that starts carrying something new fails here until it
 * is listed and the words name it. The instructions and the app's own fields carry nothing of the
 * User's.
 */
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, test } from "vitest";
import type { Core } from "../../src/core";
import { chatGroupClassifier, decisionGroupClassifier } from "../../src/core/library/classifier";
import {
  ORGANIZE_FIELDS,
  ORGANIZE_SENDS,
  type OrganizeSend,
} from "../../src/core/library/organizeSends";
import { AIM, type PlanExcerpt } from "../../src/core/library/plan";
import { chatPlanModel } from "../../src/core/library/planModel";
import type { ChatModelSpec } from "../../src/core/providers/models";
import { type MessageKey, translate } from "../../src/shared/i18n";
import { createTempDataFolder, startCore } from "../helpers/core";
import { addAndProcess, createSourceFolder, writeSourceFile } from "../helpers/documents";
import { JEV_KEY, startFakeJev } from "../helpers/jev";

type CallOptions = Parameters<MockLanguageModelV4["doGenerate"]>[0];

/** The User's own words in the requests below: none may reach the instructions or the app's fields. */
const THEIRS = ["Zephyr", "Kestrel", "Osprey", "Heron", "Plover"];

const REQUESTS: Record<string, string> = {
  folder_plan: "sort",
  placements: "place",
  subfolders: "subfolders",
  document_group: "document",
};

/** A key a request makes from an id (a Tag's, a Folder's, Not in a Folder's): one field for all. */
const KEYED = /^(t-|g-|__unsorted__$|[0-9a-f]{8}-[0-9a-f]{4}-)/;

/** Each field of a request, by path, with the values it held. */
function fieldsOf(request: string, value: unknown, into = new Map<string, unknown[]>()) {
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

const formatOf = (options: CallOptions) =>
  options.responseFormat?.type === "json" ? options.responseFormat : undefined;

/**
 * A chat model answering each of Organize's requests in its own shape, keeping each request's
 * fields and its instructions.
 */
function recording() {
  const fields = new Map<string, unknown[]>();
  const instructions: string[] = [];
  const answer = (options: CallOptions): unknown => {
    const format = formatOf(options);
    const schema = JSON.stringify(format?.schema ?? {});
    const refs = [...schema.matchAll(/"(d\d+)"/g)].map((match) => match[1]);
    switch (format?.name) {
      case "folder_plan":
        return {
          folders: [{ key: "N1", name: "Plover", description: "Plover work." }],
          documents: refs.map((ref) => ({ ref, folder: "N1" })),
        };
      case "placements":
        return { placements: refs.map((ref) => ({ ref, folder: "none" })) };
      case "subfolders":
        return { groups: [] };
      default:
        return { groupId: "__unsorted__", tags: [], newTags: [] };
    }
  };
  const model = new MockLanguageModelV4({
    doGenerate: async (options) => {
      const request = REQUESTS[formatOf(options)?.name ?? ""];
      for (const message of options.prompt) {
        if (message.role === "system") instructions.push(message.content);
        if (message.role !== "user") continue;
        for (const part of message.content)
          if (part.type === "text") fieldsOf(request ?? "unknown", JSON.parse(part.text), fields);
      }
      return {
        content: [{ type: "text", text: JSON.stringify(answer(options)) }],
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
  [...fields.keys()].filter((path) => !(path in ORGANIZE_FIELDS));

/** The fields that hold only the app's own, whose values carry any of the User's words. */
const leaked = (fields: Map<string, unknown[]>) =>
  [...fields].filter(
    ([path, values]) =>
      ORGANIZE_FIELDS[path]?.every((kind) => kind === "app") &&
      values.some((value) => THEIRS.some((word) => String(value).includes(word))),
  );

const excerpt = (ref: string): PlanExcerpt => ({
  ref,
  name: "Zephyr berth review",
  type: "PowerPoint deck",
  text: "2 slides: 1. Zephyr quay; 2. Berths\n\nZephyr quay depth was low in March.",
});
const folders = [
  { id: "F1", name: "Kestrel › Heron", description: "Kestrel port work." },
  { id: "N1", name: "Plover", description: "Plover work." },
];
const groups = [{ id: "g-kestrel", name: "Kestrel", description: "Kestrel port work." }];
const tags = [{ id: "t-osprey", name: "Osprey", description: "Osprey berth notes." }];
const deck = {
  name: "Zephyr berth review",
  kind: "pptx" as const,
  pageCount: 2,
  outline: "2 slides: 1. Zephyr quay; 2. Berths",
  text: "Zephyr quay depth was low in March.",
};

describe("Every request Organize builds carries only what its consent words name (#1569)", () => {
  // protects=each field of the plan's three requests, the per-Document chat request and a decision host's request is listed with its kinds, and the list holds no field none of them carries; fails_when=a request carries a field the list doesn't name, or the list keeps one no request sends; no_claim=what the model answers.
  test("each request's fields are the listed ones, no more and no fewer", async () => {
    const chat = recording();
    const signal = new AbortController().signal;
    const plan = chatPlanModel(chat.model);
    await plan.sort(
      {
        documents: [excerpt("d1")],
        folders: [folders[0] as (typeof folders)[number]],
        language: "en",
        within: "Kestrel",
        aim: AIM,
      },
      signal,
    );
    await plan.place([excerpt("d2")], folders, signal);
    await plan.nameSubfolders(
      [{ ref: "S1.1", parent: "Plover", documents: [excerpt("d3")] }],
      "zh-CN",
      signal,
    );
    await chatGroupClassifier(chat.model, false, true).organize(groups, tags, deck, signal, [
      { page: 1, data: "aGVsbG8=" },
    ]);
    const jev = await startFakeJev();
    jev.chooseGroup("g-kestrel");
    await decisionGroupClassifier({
      baseUrl: jev.url,
      apiKey: JEV_KEY,
      model: "jev-1",
      local: false,
    }).organize(groups, tags, deck, signal);
    const fields = chat.fields;
    for (const request of jev.requests) fieldsOf("decision", request.body, fields);

    expect(unlisted(fields)).toEqual([]);
    expect(Object.keys(ORGANIZE_FIELDS).filter((path) => !fields.has(path))).toEqual([]);
    expect(leaked(fields)).toEqual([]);
    expect(chat.instructions.filter((text) => THEIRS.some((word) => text.includes(word)))).toEqual(
      [],
    );
  });

  // protects=a run of the Library's Organize and of Organize This Folder, as the core makes them from stored Documents, sends only listed fields; fails_when=the organizer or the excerpt reader adds a field to what it sends; no_claim=the plan's Folders.
  test("the core's own runs send only the listed fields", async () => {
    const chat = recording();
    const dataDir = await createTempDataFolder();
    const core: Core = startCore(dataDir, {
      createChatModel: (_spec: ChatModelSpec) => chat.model,
    });
    const provider = await core.saveChatProvider({
      kind: "anthropic",
      apiKey: "sk-ant-test",
      modelId: "claude-haiku-5-5",
    });
    if (!provider.service) throw new Error("Anthropic has no service.");
    expect(await core.allowOrganize(provider.service.id)).toMatchObject({ ready: true });
    const kestrel = await core.createLibraryGroup({
      name: "Kestrel",
      description: "Kestrel port work.",
    });
    const sources = await createSourceFolder();
    const paths = await Promise.all(
      [1, 2, 3].map((index) =>
        writeSourceFile(sources, `Zephyr ${index}.md`, `# Zephyr ${index}\n\nThe quay was low.`),
      ),
    );
    const documents = await addAndProcess(core, paths);
    await core.organizeLibrary();
    for (const document of documents) await core.assignDocumentGroup(document.id, kestrel.id);
    await core.organizeLibrary({ folderId: kestrel.id });

    expect(chat.fields.has("sort.within")).toBe(true);
    expect(unlisted(chat.fields)).toEqual([]);
    expect(leaked(chat.fields)).toEqual([]);
    expect(chat.instructions.filter((text) => THEIRS.some((word) => text.includes(word)))).toEqual(
      [],
    );
  });
});

/** How each sentence names a kind: a kind added to the list doesn't compile until it has its words. */
const SAID: Record<OrganizeSend, Record<"en" | "zh-CN", string>> = {
  "document-name": { en: "Document’s name", "zh-CN": "文档的名称" },
  "document-kind": { en: "kind and page count", "zh-CN": "类型和页数" },
  "document-start": { en: "the start of its text", "zh-CN": "开头部分的文字" },
  "document-outline": { en: "slide titles or sheet names", "zh-CN": "幻灯片标题或工作表名称" },
  "folder-name": { en: "Folders’ names", "zh-CN": "文件夹名称" },
  "folder-description": { en: "Folders’ names and descriptions", "zh-CN": "文件夹名称和描述" },
  "tag-name": { en: "Tags’ names", "zh-CN": "标签的名称" },
  "tag-description": { en: "Tags’ names and descriptions", "zh-CN": "标签的名称和描述" },
  language: { en: "interface language", "zh-CN": "界面语言" },
};

/** Every sentence that asks for Organize's consent: the card, the footer's popover, the key's line. */
const ASKING: readonly MessageKey[] = [
  "library.organize.consent.sends",
  "library.toSort.sends.one",
  "library.toSort.sends.other",
  "needsModel.organize",
];

describe("The words that ask for Organize's consent name every kind it sends (#1569)", () => {
  // protects=the card, the footer's popover and the key's line each name every kind in the list, in English and Chinese; fails_when=a sentence names fewer kinds than Organize sends; no_claim=how the sentence reads.
  test.each(["en", "zh-CN"] as const)("%s", (language) => {
    const missing = ASKING.flatMap((key) => {
      const sentence = translate(language, key, { service: "Anthropic", count: 4 });
      return ORGANIZE_SENDS.filter((kind) => !sentence.includes(SAID[kind][language])).map(
        (kind) => `${key}: ${kind}`,
      );
    });
    expect(missing).toEqual([]);
  });
});
