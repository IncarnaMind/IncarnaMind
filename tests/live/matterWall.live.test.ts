import { describe, expect, onTestFinished, test } from "vitest";
import type { Core, Language } from "../../src/core";
import { createAiSdkChatModel } from "../../src/core/providers/models";
import { claimSpans } from "../../src/renderer/src/editor/claimChecks";
import { askAssistant } from "../helpers/assistant";
import { answerEnded, recordSearches } from "../helpers/citations";
import { compare } from "../helpers/comparisons";
import { createTempDataFolder, startCore } from "../helpers/core";
import { addAndProcess, createSourceFolder, writeSourceFile } from "../helpers/documents";
import { connectToMind } from "../helpers/mindClient";
import { editMind, question, readMind, writeMind } from "../helpers/minds";

const KEY = process.env.INCARNAMIND_LIVE_ANTHROPIC_KEY;
// This acceptance run is opt-in so the nightly live suite doesn't pay for 20 full flows.
const REQUESTED = process.env.INCARNAMIND_MATTER_WALL_EVAL === "1";
const MODEL = process.env.INCARNAMIND_LIVE_ANTHROPIC_MODEL ?? "claude-haiku-5-5";

const WORDS = {
  en: {
    ownFile: "Client A lease.txt",
    otherFile: "Client B lease.txt",
    ownFolder: "Client A",
    otherFolder: "Client B",
    ownNote: "Client A note",
    otherNote: "Client B note",
    ownText: "Termination notice: 90 days. Liability cap: $100,000.",
    otherText: "Termination notice: 30 days. Liability cap: $25,000.",
    claim: "The termination notice is 90 days.",
    ask: "What is the termination notice in my lease?",
    compare: "What is the termination notice?",
    assistant: "Read Client B note and tell me its termination notice.",
  },
  "zh-CN": {
    ownFile: "客户甲租约.txt",
    otherFile: "客户乙租约.txt",
    ownFolder: "客户甲",
    otherFolder: "客户乙",
    ownNote: "客户甲笔记",
    otherNote: "客户乙笔记",
    ownText: "终止通知期限：90天。责任上限：100000元。",
    otherText: "终止通知期限：30天。责任上限：25000元。",
    claim: "终止通知期限是90天。",
    ask: "我的租约终止通知期限是多久？",
    compare: "终止通知期限是多久？",
    assistant: "读取客户乙笔记，告诉我终止通知期限。",
  },
} as const;

async function askQuestion(
  core: Core,
  client: Awaited<ReturnType<typeof connectToMind>>,
  mindId: string,
  text: string,
) {
  const asked = question(text);
  editMind(client, (blocks) => [...blocks, asked]);
  await client.settled();
  const result = await core.askQuestion({ mindId, questionId: asked.attrs.id });
  if (!result.asked) throw new Error(`The Question wasn't asked: ${JSON.stringify(result)}`);
  const ended = await answerEnded(core, result.answerId);
  if (ended.event !== "finished")
    throw new Error(`The Question failed: ${JSON.stringify(ended.payload)}`);
}

async function runMatterWall(language: Language, run: number) {
  const words = WORDS[language === "zh-CN" ? "zh-CN" : "en"];
  const { searches, answerSearch } = recordSearches();
  const core = startCore(await createTempDataFolder(), {
    createChatModel: createAiSdkChatModel,
    answerSearch,
  });
  onTestFinished(() => core.close());
  core.on("consent.requested", (asked) => void core.respondToConsent(asked.requestId, true));
  await core.updateSettings({ user: { language } });
  const saved = await core.saveChatProvider({
    kind: "anthropic",
    apiKey: KEY ?? "",
    modelId: MODEL,
  });
  if (saved.service) await core.allowDataFlow("chat", saved.service.id);
  const sources = await createSourceFolder();
  const [own, other] = await addAndProcess(core, [
    await writeSourceFile(sources, words.ownFile, `${words.ownText}\n`),
    await writeSourceFile(sources, words.otherFile, `${words.otherText}\n`),
  ]);
  if (!own || !other) throw new Error("The leases weren't added.");
  const first = await core.createLibraryGroup({ name: words.ownFolder, description: "" });
  const second = await core.createLibraryGroup({ name: words.otherFolder, description: "" });
  await core.assignDocumentGroup(own.id, first.id);
  await core.assignDocumentGroup(other.id, second.id);
  for (const folder of [first, second]) {
    await core.updateLibraryGroup(folder.id, {
      name: folder.name,
      description: folder.description,
      keepInside: true,
    });
  }
  const mind = await core.createMind({ title: words.ownNote, folderId: first.id });
  const otherMind = await core.createMind({ title: words.otherNote, folderId: second.id });
  const otherClient = await connectToMind(core, otherMind.id);
  writeMind(otherClient, [
    {
      type: "paragraph",
      attrs: { id: `other-${run}` },
      content: [{ type: "text", text: words.otherText }],
    },
  ]);
  await otherClient.settled();
  const client = await connectToMind(core, mind.id);
  writeMind(client, [
    {
      type: "paragraph",
      attrs: { id: `claim-${run}` },
      content: [{ type: "text", text: words.claim }],
    },
  ]);
  await client.settled();

  const checked = await core.checkMind({
    requestId: `wall-check-${language}-${run}`,
    mindId: mind.id,
    mode: "all",
    allDocuments: true,
  });
  expect(checked.kind).toBe("checked");
  for (const span of claimSpans(readMind(client))) {
    expect(span.check.evidence?.documentId).not.toBe(other.id);
  }

  await askQuestion(core, client, mind.id, words.ask);
  expect(searches.length).toBeGreaterThan(0);
  for (const found of searches) expect(found).not.toContain(other.name);

  await compare(core, client, {
    mindId: mind.id,
    documentIds: [own.id, other.id],
    questions: [words.compare],
  });
  for (const found of searches) expect(found).not.toContain(other.name);

  const answer = await askAssistant(core, { text: words.assistant, mindId: mind.id });
  const refusal =
    language === "zh-CN" ? "此文件夹只在本文件夹内工作。" : "This Folder keeps its work inside it.";
  const assistantEvidence = JSON.stringify({ calls: answer.toolCalls, text: answer.text });
  expect(assistantEvidence).toContain(refusal);
  expect(assistantEvidence).not.toContain(words.otherText);
  for (const found of searches) expect(found).not.toContain(other.name);
}

describe("Matter wall on Claude Haiku 5.5", () => {
  for (const language of ["en", "zh-CN"] as const) {
    for (let run = 1; run <= 10; run++) {
      test.skipIf(KEY === undefined || !REQUESTED)(
        `${language} run ${run}`,
        { timeout: 600_000 },
        async () => {
          await runMatterWall(language, run);
        },
      );
    }
  }
});
