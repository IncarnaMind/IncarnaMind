/**
 * `npm run eval:tagging`: the Tags tagging proposes from what the Documents say, and what Organize
 * proposes for the walk (#2308, #2339), on set.json (see README.md).
 *
 * Each group of Documents is tagged as one run of the app's own (`tagInRun` with `chatClassifier`,
 * as a Re-tag sends it): one kind each from the fixed list, named in the group's interface
 * language, and a new topic only where 3 of the group share it, none of the User's own Tags yet.
 * The walk's files then go through Organize in a core on a temporary data folder, and what it
 * proposes is read from the Review, before anything is confirmed.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { wrapLanguageModel } from "ai";
import { test } from "vitest";
import type { DocumentKind } from "../../src/core/api";
import type { Language } from "../../src/core/language";
import { type ChatLanguageModel, createAiSdkChatModel } from "../../src/core/providers/models";
import {
  BATCH_EXCERPT_TOKENS,
  chatClassifier,
  type DocumentExcerpt,
  excerptFromPassages,
} from "../../src/core/tags/classify";
import { kindName } from "../../src/core/tags/kinds";
import { tagInRun } from "../../src/core/tags/run";
import { createFakeChatModel } from "../../src/main/fakeChatModel";
import { createTempDataFolder, startCore } from "../../tests/helpers/core";
import { addAndProcess, writeSourceFile } from "../../tests/helpers/documents";
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
  /** A Chinese Document with a Tag in Chinese; null for an English one. */
  chineseTag: boolean | null;
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
  text: excerptFromPassages([document.text], BATCH_EXCERPT_TOKENS),
});

/** Tags a group as one Re-tag run: a kind each, and a topic only where 3 of them share it. */
async function tagGroup(
  chat: ChatLanguageModel,
  documents: readonly SetDocument[],
  language: Language,
): Promise<{ tagged: Tagged[] }> {
  const run = await tagInRun({
    tagger: chatClassifier(chat, { language }),
    subjects: documents.map((document) => ({ id: document.id, excerpt: excerptOf(document) })),
    offered: new Map(),
    language,
    signal: AbortSignal.timeout(600_000),
    progress: () => {},
  });
  const tagged: Tagged[] = [];
  for (const document of documents) {
    const proposed = run.proposed.get(document.id) ?? [];
    const names = proposed.map((tag) =>
      "kind" in tag ? kindName(tag.kind, language) : "name" in tag ? tag.name : tag.tagId,
    );
    const made = proposed.flatMap((tag) => ("name" in tag ? [tag.name] : []));
    const invoice = proposed.some((tag) => "kind" in tag && tag.kind === "invoice");
    // A new topic is named in the interface's language (#2339).
    const otherLanguage = made.filter((name) => han.test(name) !== (language === "zh-CN"));
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
      chineseTag: document.language === "zh" ? names.some((name) => han.test(name)) : null,
    });
    log(`${document.id} ${document.name}: ${names.join(", ") || "(none)"}`);
  }
  return { tagged };
}

interface FolderResult {
  folders: string[];
  /** Each Document's Folder, by id; null for none. */
  placed: Record<string, string | null>;
  /** Documents in a Folder whose other Documents are mostly on their topic. */
  pure: number;
  sorted: number;
}

/**
 * Organize on the walk, as the Library's Organize runs it: its files in a core with no Folders,
 * planned into the Review, with their Tags beside, and read from there.
 */
async function organizeWalk(
  chat: ChatLanguageModel,
  documents: readonly SetDocument[],
): Promise<FolderResult> {
  const core = startCore(await createTempDataFolder(), { createChatModel: () => chat });
  try {
    await core.saveChatProvider({ kind: "ollama", modelId: "walk" });
    const sources = await createTempDataFolder();
    const paths = new Map<string, SetDocument>();
    for (const document of documents)
      paths.set(await writeSourceFile(sources, `${document.name}.md`, document.text), document);
    const added = await addAndProcess(core, [...paths.keys()]);
    const setOf = new Map(added.map((each) => [each.id, paths.get(each.path)]));
    const { automatic } = await core.getTaggingModels();
    if (!automatic) throw new Error("Automatic offers no model to organize with.");
    const { settings } = await core.getLibrary();
    await core.saveLibrarySettings({ ...settings, organizeWith: automatic.classifier });
    await core.organizeLibrary({ costAccepted: true });
    const review = await core.getOrganizeReview();
    const names = new Map(review.folders.map((folder) => [folder.id, folder.name]));
    const placed: Record<string, string | null> = {};
    for (const item of review.items) {
      const document = setOf.get(item.documentId);
      if (!document) continue;
      placed[document.id] =
        item.placement.kind === "newFolder"
          ? (names.get(item.placement.newFolderId) ?? null)
          : null;
    }
    const folders = review.folders
      .filter((folder) => folder.parentNewFolderId === null)
      .map((folder) => folder.name);
    let pure = 0;
    for (const folder of folders) {
      const inside = documents.filter((each) => placed[each.id] === folder);
      const topics = new Map<string, number>();
      for (const each of inside)
        topics.set(each.topic ?? "", (topics.get(each.topic ?? "") ?? 0) + 1);
      pure += Math.max(0, ...topics.values());
    }
    const sorted = documents.filter((each) => (placed[each.id] ?? null) !== null).length;
    log(`Folders: ${folders.join(", ")}`);
    return { folders, placed, pure, sorted };
  } finally {
    await core.close();
  }
}

const share = (count: number, of: number) =>
  of === 0 ? "–" : `${count} of ${of} (${Math.round((100 * count) / of)}%)`;

function groupLines(label: string, tagged: readonly Tagged[]): string[] {
  const invoices = tagged.filter((each) => each.isInvoice);
  const made = tagged.flatMap((each) => each.made);
  const otherLanguage = tagged.flatMap((each) => each.otherLanguage);
  const chinese = tagged.filter((each) => each.chineseTag !== null);
  return [
    `### ${label}`,
    "",
    "| Measure | Result |",
    "|---|---|",
    `| Non-invoices tagged Invoice (bar: 0) | ${tagged.filter((each) => each.falseInvoice).length} of ${tagged.length - invoices.length} |`,
    `| Invoices and receipts tagged Invoice | ${share(invoices.filter((each) => each.invoice).length, invoices.length)} |`,
    `| Documents with a fitting Tag (bar: 90%) | ${share(tagged.filter((each) => each.fitting).length, tagged.length)} |`,
    `| New topic Tags in the interface's language (bar: 95%) | ${share(made.length - otherLanguage.length, made.length)} |`,
    `| Chinese Documents with a Tag in the interface's language, reported | ${share(chinese.filter((each) => each.chineseTag).length, chinese.length)} |`,
    `| Most Tags on one Document | ${Math.max(0, ...tagged.map((each) => each.tags.length))} |`,
    `| New Tags made | ${made.length}: ${[...new Set(made)].join(", ")} |`,
    "",
    "Misses, to read by hand (the word list can miss a fitting synonym):",
    ...tagged
      .filter((each) => !each.fitting || each.falseInvoice || each.missedInvoice)
      .map(
        (each) =>
          `- ${each.name}: ${each.tags.join(", ") || "(no Tag)"}${each.falseInvoice ? " (Invoice, wrongly)" : each.missedInvoice ? " (Invoice missed)" : ""}`,
      ),
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
  const lines: string[] = [`# Tags from content (#2308, #2339)`, "", `Model: ${chat.label}.`, ""];
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
  const folders = await organizeWalk(chat.model, walk);
  results.folders = folders;
  lines.push(
    "### Organize on the walk, with no Folders",
    "",
    `Folders proposed: ${folders.folders.join(", ")} (Organize aims at 3 to 7).`,
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
