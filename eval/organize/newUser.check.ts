/**
 * `INCARNAMIND_ORGANIZE_MODE=new-user npm run eval:organize`: Organize as a new User meets it
 * (README.md). A core on a temporary data folder, with the User's chat model and no Folders, is
 * given the set's Documents, and Organize runs as the Library's "Sort these into Folders" runs it
 * (`organizeDocuments` in src/renderer/src/organizeDocuments.ts). What it proposed is scored
 * before the User confirms anything.
 */
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { generateText } from "ai";
import { test } from "vitest";
import { type Core, createAiSdkChatModel, type Document } from "../../src/core";
import { organizeExcerpt } from "../../src/core/library/excerpt";
import type { DocumentGroupAssignment } from "../../src/core/library/types";
import { catalogFacts, modelsProviderOfKind } from "../../src/core/providers/catalog";
import { type DocumentExcerpt, documentType } from "../../src/core/tags/classify";
import { createTempDataFolder, queryDatabase, startCore } from "../../tests/helpers/core";
import { addAndProcess } from "../../tests/helpers/documents";
import { type ChatSettings, chatModelSpecOf, chatProviderOf, readConfig } from "../lib/config";
import {
  bars,
  kindOf,
  type NewUserRun,
  newUserReport,
  type Outcome,
  type ProposedFolder,
  scoreNewUser,
  type TopicVerdict,
} from "./lib/newUser";
import { runOptions, selected } from "./lib/options";
import { prepare } from "./lib/prepare";
import { readSet, SET_DIRECTORY, type SetDocument } from "./lib/set";

const root = process.cwd();
const results = join(root, "eval", "results", "organize");
const save = (file: string, data: unknown) => writeFile(file, `${JSON.stringify(data, null, 2)}\n`);
const log = (line: string) => console.log(`[organize new-user] ${line}`);
/** The run stops waiting for Organize after this long, and scores what it has. */
const SETTLE_LIMIT_MS = 20 * 60_000;
const WORKING = new Set(["pending", "classifying"]);

/**
 * Waits until no Document is pending or being sorted, nor waiting out a rate limit. Stops at once
 * when the provider says the account is out of credit: no other key is tried.
 */
async function settled(core: Core, ids: ReadonlySet<string>): Promise<DocumentGroupAssignment[]> {
  const deadline = performance.now() + SETTLE_LIMIT_MS;
  for (;;) {
    const mine = (await core.getLibrary()).assignments.filter((each) => ids.has(each.documentId));
    if (mine.some((each) => each.error?.kind === "out-of-credit"))
      throw new Error("The provider says the account is out of credit. Stopped; add credit.");
    const going = mine.filter(
      (each) =>
        WORKING.has(each.status) ||
        (each.status === "waiting" && each.error?.kind === "rate-limit"),
    );
    if (going.length === 0) return mine;
    if (performance.now() > deadline) {
      log(`${going.length} Documents still going after ${SETTLE_LIMIT_MS / 60_000} minutes.`);
      return mine;
    }
    await sleep(250);
  }
}

/** Asks the judge whether a Document, as Organize reads it, is about a Tag's subject. */
function topicJudge(settings: ChatSettings) {
  const model = createAiSdkChatModel({ ...chatModelSpecOf(settings), thinking: "off" });
  const used = { requests: 0, input: 0, output: 0 };
  return {
    used,
    async about(excerpt: DocumentExcerpt, tag: string): Promise<boolean | null> {
      const document = JSON.stringify({
        name: excerpt.name,
        type: documentType(excerpt),
        ...(excerpt.outline ? { outline: excerpt.outline } : {}),
        text: excerpt.text,
      });
      const result = await generateText({
        model,
        prompt: `The Document:\n${document}\n\nIs this Document about '${tag}'? Answer yes or no.`,
        maxOutputTokens: 16,
        maxRetries: 2,
        abortSignal: AbortSignal.timeout(120_000),
      });
      used.requests++;
      used.input += result.usage.inputTokens ?? 0;
      used.output += result.usage.outputTokens ?? 0;
      const answer = result.text.trim().toLowerCase();
      return answer.startsWith("yes") ? true : answer.startsWith("no") ? false : null;
    },
  };
}

/** The app's model requests, per model and data flow, as its meter recorded them. */
function metered(dataDir: string): NewUserRun["spend"] {
  return queryDatabase<{
    model: string;
    flow: string;
    requests: number;
    input: number | null;
    output: number | null;
    cost: number | null;
  }>(
    dataDir,
    `SELECT model_id AS model, flow, COUNT(*) AS requests, SUM(input_tokens) AS input,
       SUM(output_tokens) AS output, SUM(cost) AS cost
     FROM model_requests WHERE deleted_at IS NULL GROUP BY model_id, flow ORDER BY model_id, flow`,
  ).map((row) => ({
    who: `${row.model} (${row.flow})`,
    requests: row.requests,
    input: row.input ?? 0,
    output: row.output ?? 0,
    cost: row.cost,
  }));
}

test("Organize as a new User meets it", async () => {
  const set = await readSet(root);
  const config = readConfig(root);
  const options = runOptions(process.env, "heldout");
  const chat = config.chat;
  if (!chat)
    throw new Error(
      "The new-User mode runs on the User's chat model: set INCARNAMIND_EVAL_CHAT_KIND, _MODEL and _KEY.",
    );
  const judgeSettings = config.judge ?? chat;
  const documents = selected(set.documents, options);
  const startedAt = new Date().toISOString();
  const output = join(results, `new-user-${startedAt.replace(/[:.]/g, "-")}`);
  await mkdir(output, { recursive: true });

  const dataDir = await createTempDataFolder();
  const core = startCore(dataDir, {
    createChatModel: createAiSdkChatModel,
    systemLanguages: () => [options.language === "zh-CN" ? "zh-CN" : "en-US"],
  });
  // Only what the User's "Use {company}" allows goes: sorting the Documents with Organize's model.
  core.on("consent.requested", (request) => {
    const allowed = request.flow.id === "classification";
    log(`${allowed ? "Allowed" : "Declined"} the ${request.flow.id} flow.`);
    void core.respondToConsent(request.requestId, allowed);
  });
  await core.saveChatProvider(chatProviderOf(chat));

  log(`Adding ${documents.length} Documents…`);
  const paths = new Map(documents.map((doc) => [join(root, SET_DIRECTORY, doc.file), doc]));
  const added = await addAndProcess(core, [...paths.keys()], 10 * 60_000);
  const setDocOf = new Map<string, SetDocument>();
  for (const document of added) {
    const doc = paths.get(document.path);
    if (!doc) throw new Error(`Added a file the set doesn't list: ${document.path}`);
    setDocOf.set(document.id, doc);
  }
  if (setDocOf.size !== documents.length)
    throw new Error(`Only ${setDocOf.size} of ${documents.length} files were added.`);

  // As the Library's buttons: the User's own Documents in no Folder, in the order it lists them.
  const listed = await core.listDocuments();
  const ids = listed.filter((each) => setDocOf.has(each.id)).map((each) => each.id);
  const library = await core.getLibrary();
  if (library.groups.length > 0) throw new Error("A new User's Library has Folders already.");

  // With no model for Organize yet, the press asks for one, and "Use {company}" keeps the model
  // Automatic offers, which is the consent for where it sends.
  const { automatic } = await core.getTaggingModels();
  if (!automatic) throw new Error("Automatic offers no model to organize with.");
  if (automatic.classifier.kind !== "chat")
    throw new Error(
      `Automatic offers ${automatic.name}, which can't name Folders: the starter Folders open instead.`,
    );
  await core.saveLibrarySettings({ ...library.settings, organizeWith: automatic.classifier });
  log(`Organizing with ${automatic.name}…`);

  const pressed = performance.now();
  let firstPlacementMs: number | null = null;
  const watching = new Set(ids);
  const stop = core.on("library.assignments", (changed) => {
    if (
      firstPlacementMs === null &&
      changed.some((each) => watching.has(each.documentId) && each.groupId !== null)
    )
      firstPlacementMs = performance.now() - pressed;
  });
  const made = await core.proposeFolders(ids);
  const proposedMs = performance.now() - pressed;
  log(`${made.length} Folders proposed: ${made.map((folder) => folder.name).join(", ")}`);
  if (made.length > 0) await core.classifyDocuments(ids);
  const assignments = await settled(core, watching);
  const totalMs = performance.now() - pressed;
  stop();

  const after = await core.getLibrary();
  const tagNames = new Map((await core.listTags()).map((tag) => [tag.id, tag.name]));
  const documentsNow = new Map<string, Document>(
    (await core.listDocuments()).map((each) => [each.id, each]),
  );
  const folders: ProposedFolder[] = after.groups.map(({ id, name, description }) => ({
    id,
    name,
    description,
  }));
  const outcomes: Outcome<SetDocument>[] = ids.map((id) => {
    const document = documentsNow.get(id);
    const assignment = assignments.find((each) => each.documentId === id);
    return {
      doc: setDocOf.get(id) as SetDocument,
      readable: document?.status === "ready",
      folder: assignment?.groupId ?? null,
      tags: (document?.tags ?? []).map((tag) => tagNames.get(tag.tagId) ?? tag.tagId),
      status: assignment?.status ?? document?.status ?? "none",
      error: assignment?.error?.message ?? null,
    };
  });
  const spend = metered(dataDir);
  await save(join(output, "results.json"), { folders, outcomes, spend });

  log("Asking the judge about each topic Tag…");
  const judge = topicJudge(judgeSettings);
  const verdicts: TopicVerdict[] = [];
  for (const outcome of outcomes) {
    const topics = outcome.tags.filter((tag) => kindOf(tag) === null);
    if (!outcome.readable || topics.length === 0) continue;
    const excerpt = organizeExcerpt((await prepare(root, outcome.doc)).source);
    for (const tag of topics)
      verdicts.push({ id: outcome.doc.id, tag, about: await judge.about(excerpt, tag) });
  }
  const price = catalogFacts(
    modelsProviderOfKind(judgeSettings.kind, judgeSettings.endpoint),
    judgeSettings.modelId,
  )?.price;
  spend.push({
    who: `${judgeSettings.modelId} (the judge, not the app)`,
    ...judge.used,
    cost:
      price?.currency === "USD"
        ? (judge.used.input * price.input + judge.used.output * price.output) / 1e6
        : null,
  });

  let commit = "unknown";
  try {
    commit = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: root }).toString().trim();
  } catch {
    // Not a checkout: the report says so.
  }
  const run: NewUserRun = {
    startedAt,
    commit,
    language: options.language,
    chatModel: `${chat.kind}/${chat.modelId}`,
    organizeModel: automatic.name,
    judge: `${judgeSettings.kind}/${judgeSettings.modelId}`,
    listMistakes: options.showHeldOut || !options.splits.includes("heldout"),
    proposedMs,
    firstPlacementMs,
    totalMs,
    spend,
  };
  await save(join(output, "results.json"), { run, folders, outcomes, verdicts });
  await writeFile(join(output, "report.md"), newUserReport(run, outcomes, folders, verdicts));
  for (const bar of bars(scoreNewUser(outcomes, folders, verdicts)))
    log(`${bar.pass ? "PASS" : "FAIL"} ${bar.name}: ${bar.value} (bar ${bar.bar})`);
  log(`Report: ${join(output, "report.md")}`);
});
