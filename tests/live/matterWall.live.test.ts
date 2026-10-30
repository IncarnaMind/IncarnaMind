import { describe, expect, onTestFinished, test } from "vitest";
import type { Core, Language } from "../../src/core";
import { createAiSdkChatModel } from "../../src/core/providers/models";
import { claimSpans } from "../../src/renderer/src/editor/claimChecks";
import { translate } from "../../src/shared/i18n";
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
    outsideFile: "Other lease.txt",
    ownFolder: "Client A",
    otherFolder: "Client B",
    outsideFolder: "Other work",
    ownNote: "Client A note",
    otherNote: "Client B note",
    outsideNote: "Outside note",
    ownText: "Termination notice: 90 days. Liability cap: $100,000.",
    ownCap: /100[.,\s]?000/,
    otherText: "Termination notice: 30 days. Liability cap: $25,000.",
    outsideText: "Termination notice: 60 days.",
    claim: "The termination notice is 90 days.",
    ask: "What is the termination notice in my lease?",
    compare: "What is the termination notice?",
    assistant: "Read Client B note and tell me its termination notice.",
    followUp: "What notice did you just tell me about, in days?",
    quoted: "What does this quote say about the notice?",
    command: "Rename the Document Client B lease.txt to Renamed lease.txt.",
  },
  "zh-CN": {
    ownFile: "客户甲租约.txt",
    otherFile: "客户乙租约.txt",
    outsideFile: "其他租约.txt",
    ownFolder: "客户甲",
    otherFolder: "客户乙",
    outsideFolder: "其他工作",
    ownNote: "客户甲笔记",
    otherNote: "客户乙笔记",
    outsideNote: "外部笔记",
    ownText: "终止通知期限：90天。责任上限：100000元。",
    ownCap: /100[,，.\s]?000|10\s*万/,
    otherText: "终止通知期限：30天。责任上限：25000元。",
    outsideText: "终止通知期限：60天。",
    claim: "终止通知期限是90天。",
    ask: "我的租约终止通知期限是多久？",
    compare: "终止通知期限是多久？",
    assistant: "读取客户乙笔记，告诉我终止通知期限。",
    followUp: "你刚才说的通知期限是多少天？",
    quoted: "这段引文说通知期限是多久？",
    command: "把文档“客户乙租约.txt”重命名为“改名租约.txt”。",
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
  const [own, other, outsideDocument] = await addAndProcess(core, [
    await writeSourceFile(sources, words.ownFile, `${words.ownText}\n`),
    await writeSourceFile(sources, words.otherFile, `${words.otherText}\n`),
    await writeSourceFile(sources, words.outsideFile, `${words.outsideText}\n`),
  ]);
  if (!own || !other || !outsideDocument) throw new Error("The leases weren't added.");
  const first = await core.createLibraryGroup({ name: words.ownFolder, description: "" });
  const second = await core.createLibraryGroup({ name: words.otherFolder, description: "" });
  const outsideFolder = await core.createLibraryGroup({
    name: words.outsideFolder,
    description: "",
  });
  await core.assignDocumentGroup(own.id, first.id);
  await core.assignDocumentGroup(other.id, second.id);
  await core.assignDocumentGroup(outsideDocument.id, outsideFolder.id);
  for (const folder of [first, second]) {
    await core.updateLibraryGroup(folder.id, {
      name: folder.name,
      description: folder.description,
      keepInside: true,
    });
  }
  const mind = await core.createMind({ title: words.ownNote, folderId: first.id });
  const otherMind = await core.createMind({ title: words.otherNote, folderId: second.id });
  const outsideMind = await core.createMind({ title: words.outsideNote });
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
  const refusal = translate(language, "folder.wall.refusal");
  const assistantEvidence = JSON.stringify({ calls: answer.toolCalls, text: answer.text });
  expect(assistantEvidence).toContain(refusal);
  expect(assistantEvidence).not.toContain(words.otherText);
  for (const found of searches) expect(found).not.toContain(other.name);

  const outsideStart = searches.length;
  /** Every Document a search since the outside Note started found: a turn may search twice, in two languages. */
  const outsideSearched = () => [...new Set(searches.slice(outsideStart).flat())].sort();
  const outsideClient = await connectToMind(core, outsideMind.id);
  writeMind(outsideClient, [
    {
      type: "paragraph",
      attrs: { id: `outside-${run}` },
      content: [{ type: "text", text: words.claim }],
    },
  ]);
  await outsideClient.settled();
  await askQuestion(core, outsideClient, outsideMind.id, words.ask);
  expect(outsideSearched()).toEqual([outsideDocument.name]);
  const outsideChecked = await core.checkMind({
    requestId: `outside-check-${language}-${run}`,
    mindId: outsideMind.id,
    mode: "all",
    allDocuments: true,
  });
  expect(outsideChecked.kind).toBe("checked");
  for (const span of claimSpans(readMind(outsideClient))) {
    expect(span.check.evidence?.documentId).not.toBe(own.id);
    expect(span.check.evidence?.documentId).not.toBe(other.id);
  }
  await compare(core, outsideClient, {
    mindId: outsideMind.id,
    documentIds: [own.id, other.id, outsideDocument.id],
    questions: [words.compare],
  });
  expect(outsideSearched()).toEqual([outsideDocument.name]);
  const outsideAnswer = await askAssistant(core, { text: words.assistant, mindId: outsideMind.id });
  expect(
    JSON.stringify({ calls: outsideAnswer.toolCalls, text: outsideAnswer.text }),
  ).not.toContain(words.otherText);
  for (const found of searches.slice(outsideStart)) {
    expect(found).not.toContain(own.name);
    expect(found).not.toContain(other.name);
  }

  // A follow-up from the other side of the wall gets none of the turn before, and still answers
  // from the outside: the outside Note's 90 days or the outside lease's 60.
  const inside = await askAssistant(core, { text: words.ask, mindId: mind.id });
  const followUp = await askAssistant(core, {
    text: words.followUp,
    mindId: outsideMind.id,
    conversationId: inside.conversationId,
  });
  expect(followUp.text).toMatch(/90|60/);
  expect(followUp.text).not.toMatch(words.ownCap);
  expect(followUp.text).not.toContain(words.ownFile);
  expect(followUp.text).not.toContain(words.ownFolder);
  expect(JSON.stringify(followUp.toolCalls)).not.toContain(words.ownText);

  // A quote from a walled Document is left out of a Question asked outside.
  const quotedAsk = await core.askInConversation({
    text: words.quoted,
    mindId: outsideMind.id,
    quotes: [
      {
        documentId: own.id,
        documentName: own.name,
        quote: words.ownText,
        pageFrom: null,
        pageTo: null,
        location: null,
      },
    ],
  });
  if (!quotedAsk.asked) throw new Error(`The quote wasn't asked: ${JSON.stringify(quotedAsk)}`);
  expect(quotedAsk.leftOut).toHaveLength(1);
  expect((await answerEnded(core, quotedAsk.answerId)).event).toBe("finished");
  const { messages } = await core.getConversation(quotedAsk.conversation.id);
  const quotedAnswer = messages.find((message) => message.id === quotedAsk.answerId);
  // It still answers from the outside, the Note's 90 or the outside lease's 60; the walled
  // Document's cap and name do not.
  expect(quotedAnswer?.text).toMatch(/90|60/);
  expect(quotedAnswer?.text).not.toMatch(words.ownCap);
  expect(quotedAnswer?.text).not.toContain(words.ownFile);
  expect(quotedAnswer?.text).not.toContain(words.ownFolder);

  // A command from inside one wall can't reach a Document behind another.
  await askAssistant(core, { text: words.command, mindId: mind.id });
  const renamed = (await core.listDocuments()).find((each) => each.id === other.id);
  expect(renamed?.name).toBe(other.name);
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
