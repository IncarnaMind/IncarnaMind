/**
 * `npm run eval:tagging`: Tags from what the Documents say, and the Folders Organize proposes
 * where there are none (#2308), on set.json (see README.md).
 *
 * Each group of Documents is tagged one at a time, as the app does, through the app's own
 * tagger (`chatClassifier`) with the preset Tags in the group's interface language: a new Tag a
 * Document brings joins the list the next one is offered, found again by `tagKey` and held to
 * `NEW_TAG_LIMIT`, as `TagsStore.applyAutomatic` does. The walk's group then goes through
 * Organize: one Folder proposal (`proposeFolders`), then a Folder for each Document
 * (`organize`). No app database, embeddings or data folder.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { wrapLanguageModel } from "ai";
import { test } from "vitest";
import type { DocumentKind } from "../../src/core/api";
import type { Language } from "../../src/core/language";
import { chatGroupClassifier } from "../../src/core/library/classifier";
import type { LibraryGroup } from "../../src/core/library/types";
import { type ChatLanguageModel, createAiSdkChatModel } from "../../src/core/providers/models";
import {
  chatClassifier,
  type DocumentExcerpt,
  documentType,
  excerptFromPassages,
  type TagDefinition,
} from "../../src/core/tags/classify";
import { PRESET_TAGS } from "../../src/core/tags/presets";
import { NEW_TAG_LIMIT, tagKey } from "../../src/core/tags/suggest";
import { createFakeChatModel } from "../../src/main/fakeChatModel";
import { chatModelSpecOf, chatSettings } from "../lib/config";

interface SetDocument {
  id: string;
  split: "tune" | "heldout" | "walk";
  language: "en" | "zh";
  topic?: string;
  name: string;
  kind: DocumentKind;
  pageCount: number | null;
  text: string;
  invoice: boolean;
  fits: string[];
}

interface Tagged {
  id: string;
  name: string;
  tags: string[];
  made: string[];
  /** It was tagged Invoice. */
  invoice: boolean;
  /** It is an invoice or a receipt. */
  isInvoice: boolean;
  fitting: boolean;
  falseInvoice: boolean;
  missedInvoice: boolean;
  /** New Tags named in another language than the Document's. */
  otherLanguage: string[];
}

const root = process.cwd();
const env = process.env;
const log = (line: string) => console.log(`[tagging] ${line}`);
const han = /\p{Script=Han}/u;
const plain = (text: string) => text.normalize("NFKC").toLowerCase();

function model(): { label: string; model: ChatLanguageModel; tokens: () => Tokens } {
  let tokens: Tokens = { input: 0, output: 0 };
  const counted = (inner: ChatLanguageModel): ChatLanguageModel =>
    wrapLanguageModel({
      model: inner,
      middleware: {
        specificationVersion: "v4",
        wrapGenerate: async ({ doGenerate }) => {
          const result = await doGenerate();
          tokens = {
            input: tokens.input + (result.usage.inputTokens.total ?? 0),
            output: tokens.output + (result.usage.outputTokens.total ?? 0),
          };
          return result;
        },
      },
    });
  const chat = chatSettings(env);
  const route = env.INCARNAMIND_TAGGING_ROUTE ?? (chat ? "chat" : "scripted");
  if (route === "scripted")
    return {
      label: "The smoke tests' scripted chat model (no model, no network)",
      model: counted(
        createFakeChatModel({ kind: "ollama", baseUrl: null, apiKey: null, modelId: "scripted" }),
      ),
      tokens: () => tokens,
    };
  if (!chat)
    throw new Error(
      "The chat route needs INCARNAMIND_EVAL_CHAT_KIND and INCARNAMIND_EVAL_CHAT_MODEL (and a key for a cloud provider).",
    );
  return {
    label: `Chat model ${chat.kind}/${chat.modelId}, thinking off as the app asks`,
    model: counted(createAiSdkChatModel({ ...chatModelSpecOf(chat), thinking: "off" })),
    tokens: () => tokens,
  };
}

interface Tokens {
  input: number;
  output: number;
}

const excerptOf = (document: SetDocument): DocumentExcerpt => ({
  name: document.name,
  kind: document.kind,
  pageCount: document.pageCount,
  text: excerptFromPassages([document.text]),
});

const presets = (language: Language): TagDefinition[] =>
  PRESET_TAGS.map((preset) => ({ id: `preset:${preset.key}`, ...preset.text[language] }));

/** Tags a group one Document at a time, the Tags made joining the list as in the app. */
async function tagGroup(
  chat: ChatLanguageModel,
  documents: readonly SetDocument[],
  language: Language,
): Promise<{ tagged: Tagged[]; tags: TagDefinition[] }> {
  const tags = presets(language);
  const tagger = chatClassifier(chat);
  const tagged: Tagged[] = [];
  for (const document of documents) {
    const signal = AbortSignal.timeout(180_000);
    const choice = await tagger.decide({ tags, excerpt: excerptOf(document), signal });
    const ids = new Set(choice.decisions.map((each) => each.tagId));
    const made: string[] = [];
    for (const named of choice.newTags) {
      const same = tags.find((each) => tagKey(each.name) === tagKey(named.name));
      if (same) {
        ids.add(same.id);
      } else if (tags.length < NEW_TAG_LIMIT) {
        const id = `new:${tags.length}`;
        tags.push({ id, ...named });
        ids.add(id);
        made.push(named.name);
      }
    }
    const names = [...ids].map((id) => tags.find((each) => each.id === id)?.name ?? id);
    const invoice = ids.has("preset:invoice");
    const otherLanguage = made.filter((name) => han.test(name) !== (document.language === "zh"));
    tagged.push({
      id: document.id,
      name: document.name,
      tags: names,
      made,
      invoice,
      isInvoice: document.invoice,
      fitting: names.some((name) =>
        document.fits.some((word) => plain(name).includes(plain(word))),
      ),
      falseInvoice: invoice && !document.invoice,
      missedInvoice: document.invoice && !invoice,
      otherLanguage,
    });
    log(`${document.id} ${document.name}: ${names.join(", ") || "(none)"}`);
  }
  return { tagged, tags };
}

interface FolderResult {
  folders: string[];
  /** Each Document's Folder, by id; null for none. */
  placed: Record<string, string | null>;
  /** Documents in a Folder whose other Documents are mostly on their topic. */
  pure: number;
  sorted: number;
}

/** Organize on the walk: a proposal, then a Folder for each Document, with the Tags so far. */
async function organizeWalk(
  chat: ChatLanguageModel,
  documents: readonly SetDocument[],
  tags: readonly TagDefinition[],
): Promise<FolderResult> {
  const classifier = chatGroupClassifier(chat, false);
  const proposed =
    (await classifier.proposeFolders?.(
      documents.map((each) => ({
        name: each.name,
        type: documentType(excerptOf(each)),
        text: excerptFromPassages([each.text], 120),
      })),
      [],
      "en",
      AbortSignal.timeout(180_000),
    )) ?? [];
  const groups: LibraryGroup[] = proposed.map((folder, at) => ({
    id: `g-${at}`,
    ...folder,
    countsOwnFiles: false,
    keepInside: false,
    createdAt: "",
    updatedAt: "",
  }));
  const placed: Record<string, string | null> = {};
  for (const document of documents) {
    const { groupId } = await classifier.organize(
      groups,
      [...tags],
      excerptOf(document),
      AbortSignal.timeout(180_000),
    );
    placed[document.id] = groups.find((group) => group.id === groupId)?.name ?? null;
  }
  let pure = 0;
  for (const folder of proposed) {
    const inside = documents.filter((each) => placed[each.id] === folder.name);
    const topics = new Map<string, number>();
    for (const each of inside)
      topics.set(each.topic ?? "", (topics.get(each.topic ?? "") ?? 0) + 1);
    pure += Math.max(0, ...topics.values());
  }
  const sorted = documents.filter((each) => placed[each.id] !== null).length;
  log(`Folders: ${proposed.map((each) => each.name).join(", ")}`);
  return { folders: proposed.map((each) => each.name), placed, pure, sorted };
}

const share = (count: number, of: number) =>
  of === 0 ? "–" : `${count} of ${of} (${Math.round((100 * count) / of)}%)`;

function groupLines(label: string, tagged: readonly Tagged[]): string[] {
  const invoices = tagged.filter((each) => each.isInvoice);
  const made = tagged.flatMap((each) => each.made);
  const otherLanguage = tagged.flatMap((each) => each.otherLanguage);
  return [
    `### ${label}`,
    "",
    "| Measure | Result |",
    "|---|---|",
    `| Non-invoices tagged Invoice (bar: 0) | ${tagged.filter((each) => each.falseInvoice).length} of ${tagged.length - invoices.length} |`,
    `| Invoices and receipts tagged Invoice | ${share(invoices.filter((each) => each.invoice).length, invoices.length)} |`,
    `| Documents with a fitting Tag (bar: 90%) | ${share(tagged.filter((each) => each.fitting).length, tagged.length)} |`,
    `| New Tags in the Document's language (bar: 95%) | ${share(made.length - otherLanguage.length, made.length)} |`,
    `| Most Tags on one Document (bar: 3) | ${Math.max(0, ...tagged.map((each) => each.tags.length))} |`,
    `| New Tags made | ${made.length}: ${[...new Set(made)].join(", ")} |`,
    "",
    "| Document | Tags | Fits | Invoice |",
    "|---|---|---|---|",
    ...tagged.map(
      (each) =>
        `| ${each.name} | ${each.tags.join(", ") || "(none)"} | ${each.fitting ? "yes" : "**no**"} | ${each.falseInvoice ? "**wrongly**" : each.missedInvoice ? "**missed**" : each.invoice ? "yes" : ""} |`,
    ),
    "",
  ];
}

test("Tags from content, and Organize's Folders", async () => {
  const set = JSON.parse(await readFile(join(root, "eval", "tagging", "set.json"), "utf8")) as {
    documents: SetDocument[];
  };
  const asked = env.INCARNAMIND_TAGGING_SPLIT ?? "heldout";
  const split = asked === "tuning" ? "tune" : asked;
  const chat = model();
  log(chat.label);
  const groups: { label: string; documents: SetDocument[]; language: Language }[] = [];
  for (const part of split === "all" ? ["tune", "heldout"] : [split]) {
    if (part !== "tune" && part !== "heldout") throw new Error(`Unknown split "${part}".`);
    for (const language of ["en", "zh"] as const) {
      groups.push({
        label: `${part === "tune" ? "Tuning" : "Held-out"} set, ${language === "en" ? "English" : "Chinese"}`,
        documents: set.documents.filter(
          (each) => each.split === part && each.language === language,
        ),
        language: language === "en" ? "en" : "zh-CN",
      });
    }
  }
  const lines: string[] = [`# Tags from content (#2308)`, "", `Model: ${chat.label}.`, ""];
  const results: Record<string, unknown> = {};
  for (const group of groups) {
    const { tagged } = await tagGroup(chat.model, group.documents, group.language);
    results[group.label] = tagged;
    lines.push(...groupLines(group.label, tagged));
  }
  const walk = set.documents.filter((each) => each.split === "walk");
  const walked = await tagGroup(chat.model, walk, "en");
  results.walk = walked.tagged;
  lines.push(...groupLines("The walk's 14 files (English interface)", walked.tagged));
  const wrong = walked.tagged.filter(
    (each) => ["w-1", "w-2", "w-6"].includes(each.id) && each.invoice,
  );
  const sheet = walked.tagged.find((each) => each.id === "w-7");
  lines.push(
    `Walk bars: quote, notes and registration tagged Invoice: ${wrong.length} (bar: 0); the .xlsx has a fitting Tag: ${sheet?.fitting ? "yes" : "no"} (${sheet?.tags.join(", ") || "none"}).`,
    "",
  );
  const folders = await organizeWalk(chat.model, walk, walked.tags);
  results.folders = folders;
  lines.push(
    "### Organize on the walk, with no Folders",
    "",
    `Folders proposed: ${folders.folders.join(", ")} (bar: 2 to 4).`,
    `Documents in a Folder: ${share(folders.sorted, walk.length)}; in a Folder of their own topic: ${share(folders.pure, walk.length)} (bar: 90%).`,
    "",
    ...walk.map(
      (each) => `- ${each.name} (${each.topic}) → ${folders.placed[each.id] ?? "no Folder"}`,
    ),
    "",
  );
  const tokens = chat.tokens();
  lines.push(
    `Tokens: ${tokens.input.toLocaleString("en")} in, ${tokens.output.toLocaleString("en")} out.`,
    "",
  );
  const out = join(
    root,
    "eval",
    "results",
    "tagging",
    new Date().toISOString().replace(/[:.]/g, "-"),
  );
  await mkdir(out, { recursive: true });
  await writeFile(join(out, "report.md"), lines.join("\n"));
  await writeFile(join(out, "results.json"), `${JSON.stringify(results, null, 2)}\n`);
  log(`Report: ${join(out, "report.md")}`);
  console.log(lines.join("\n"));
});
