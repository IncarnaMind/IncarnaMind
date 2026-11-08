/**
 * "This folder" in the assistant (#2529) against a real model: with a Folder in scope, the
 * Library open on one, or the Note in front in one, a request that points at it without naming
 * it is carried out on that Folder and asks nothing; with nothing to tell which of several
 * Folders, it asks, naming them. Through the core as the composer asks, English and Chinese,
 * one scope to a request. The paraphrases are held out: none is among the prompt's own
 * examples.
 *
 *   INCARNAMIND_LIVE_ANTHROPIC_KEY      the key; the test is skipped without it
 *   INCARNAMIND_LIVE_ANTHROPIC_MODEL    Claude Haiku 5.5 by default
 *   INCARNAMIND_FOLDER_REFERENCE_RUNS   how many times each request is asked (1)
 *   INCARNAMIND_LIVE_MAX_USD            stops asking once the requests have cost this much
 *   INCARNAMIND_LIVE_REPORT             a file to append each run and the rates to
 */
import { appendFile } from "node:fs/promises";
import { describe, expect, onTestFinished, test } from "vitest";
import { watchTokens } from "../../eval/lib/tokens";
import {
  CITATION_NODE,
  type ConversationAnswer,
  type Core,
  type LibraryGroup,
} from "../../src/core";
import { costOf } from "../../src/core/cost/price";
import { catalogModel } from "../../src/core/providers/catalog";
import { createAiSdkChatModel } from "../../src/core/providers/models";
import { createTempDataFolder, startCore } from "../helpers/core";
import { addAndProcess, createSourceFolder, writeSourceFile } from "../helpers/documents";
import { connectToMind } from "../helpers/mindClient";
import { readMind } from "../helpers/minds";

const KEY = process.env.INCARNAMIND_LIVE_ANTHROPIC_KEY;
const MODEL = process.env.INCARNAMIND_LIVE_ANTHROPIC_MODEL ?? "claude-haiku-5-5";
const RUNS = Number(process.env.INCARNAMIND_FOLDER_REFERENCE_RUNS ?? 1);
const MAX_USD = Number(process.env.INCARNAMIND_LIVE_MAX_USD ?? Number.POSITIVE_INFINITY);
const PRICE = catalogModel("anthropic", MODEL)?.price;

type Words = "en" | "zh-CN";

/** Made-up Documents, three Folders of them and one in none; the first Folder's words are not the others'. */
const LIBRARIES: Record<
  Words,
  {
    folders: { name: string; files: { name: string; text: string }[] }[];
    loose: { name: string; text: string };
  }
> = {
  en: {
    folders: [
      {
        name: "Reports & presentations",
        files: [
          {
            name: "Quarterly sales report",
            text: "Quarterly sales report. Sales of the Quillwood range rose 12 percent in the third quarter, led by the northern shops. Returns stayed under 2 percent. The team expects a similar rise in the fourth quarter.",
          },
          {
            name: "Customer survey results",
            text: "Customer survey results. 640 customers answered. 81 percent said delivery was fast, 64 percent would recommend the shop, and the most common complaint was the packaging.",
          },
          {
            name: "Board presentation",
            text: "Board presentation. Three slides: the year's revenue of 4.2 million, the plan to open two shops in the spring, and the hiring of a second designer.",
          },
          {
            name: "Annual review",
            text: "Annual review. The year closed with 31 staff, two new suppliers and a shorter delivery time of 3 days. The main risk named is the rising cost of timber.",
          },
        ],
      },
      {
        name: "Contracts",
        files: [
          {
            name: "Office lease",
            text: "Office lease. The lease runs five years from 1 March. Rent is 3,100 euros a month. Either side may end it with six months' notice after the second year.",
          },
          {
            name: "Supplier agreement",
            text: "Supplier agreement. The supplier delivers timber every month at a fixed price for twelve months. Late deliveries over ten days allow the buyer to cancel that month's order.",
          },
        ],
      },
      {
        name: "Research notes",
        files: [
          {
            name: "Interview notes",
            text: "Interview notes. Five shop owners were interviewed in June. Three asked for repair kits; two asked for longer guarantees. All five liked the oak finish.",
          },
          {
            name: "Market sizing",
            text: "Market sizing. The regional market for handmade furniture is about 90 million a year and grows 4 percent a year. The firm's share is under 1 percent.",
          },
        ],
      },
    ],
    loose: {
      name: "Loose reminder",
      text: "Loose reminder. Ring the printer about the new catalogue before Friday.",
    },
  },
  "zh-CN": {
    folders: [
      {
        name: "报告与演示",
        files: [
          {
            name: "季度销售报告",
            text: "季度销售报告。松木系列第三季度销售额增长12%，北方门店增长最快。退货率低于2%。团队预计第四季度会有类似的增长。",
          },
          {
            name: "客户调查结果",
            text: "客户调查结果。共有640位客户作答。81%的客户认为送货很快，64%愿意向他人推荐，最常见的抱怨是包装。",
          },
          {
            name: "董事会演示稿",
            text: "董事会演示稿。共三页：全年收入420万，春季新开两家门店的计划，以及增聘第二位设计师。",
          },
        ],
      },
      {
        name: "合同",
        files: [
          {
            name: "办公室租赁合同",
            text: "办公室租赁合同。租期五年，自3月1日起算。月租金3100欧元。第二年后，任何一方可提前六个月通知解约。",
          },
          {
            name: "供应协议",
            text: "供应协议。供应商每月按固定价格供应木材，为期十二个月。迟交超过十天的，买方可取消当月订单。",
          },
        ],
      },
      {
        name: "调研笔记",
        files: [
          {
            name: "访谈记录",
            text: "访谈记录。六月访谈了五位店主。三位希望提供维修套件，两位希望延长保修。五位都喜欢橡木饰面。",
          },
          {
            name: "市场规模估算",
            text: "市场规模估算。本地手工家具市场每年约9000万，年增长4%。本公司份额不足1%。",
          },
        ],
      },
    ],
    loose: { name: "零散备忘", text: "零散备忘。周五前联系印刷厂，谈新目录的事。" },
  },
};

/** Where the Question is asked from: a Folder in scope, a Note in a Folder with every Document or its own Folder in scope, the Library open on a Folder, or with nothing to tell which. */
type Situation = "scope" | "note" | "note-default" | "library" | "none";

interface Request {
  id: string;
  language: Words;
  situation: Situation;
  /** The Folder meant, by its place in the library; none when nothing tells. */
  folder: number | null;
  text: string;
}

const REQUESTS: readonly Request[] = [
  {
    id: "en-scope-summarise",
    language: "en",
    situation: "scope",
    folder: 0,
    text: "Summarise this folder.",
  },
  {
    id: "en-scope-whats-in",
    language: "en",
    situation: "scope",
    folder: 1,
    text: "What's in this folder?",
  },
  {
    id: "en-scope-key-points",
    language: "en",
    situation: "scope",
    folder: 2,
    text: "Give me the key points from everything in this folder.",
  },
  {
    id: "en-note-summarise",
    language: "en",
    situation: "note",
    folder: 1,
    text: "Summarise this folder.",
  },
  {
    id: "en-note-whats-in",
    language: "en",
    situation: "note",
    folder: 2,
    text: "What's in this folder?",
  },
  {
    id: "en-none-summarise",
    language: "en",
    situation: "none",
    folder: null,
    text: "Summarise this folder.",
  },
  {
    id: "zh-scope-summarise",
    language: "zh-CN",
    situation: "scope",
    folder: 0,
    text: "总结一下这个文件夹。",
  },
  {
    id: "zh-scope-whats-in",
    language: "zh-CN",
    situation: "scope",
    folder: 1,
    text: "这个文件夹里有什么？",
  },
  {
    id: "zh-scope-key-points",
    language: "zh-CN",
    situation: "scope",
    folder: 2,
    text: "把这个文件夹里资料的要点告诉我。",
  },
  {
    id: "zh-note-summarise",
    language: "zh-CN",
    situation: "note",
    folder: 1,
    text: "总结一下这个文件夹。",
  },
  {
    id: "zh-note-whats-in",
    language: "zh-CN",
    situation: "note",
    folder: 2,
    text: "这个文件夹里有什么？",
  },
  {
    id: "zh-none-summarise",
    language: "zh-CN",
    situation: "none",
    folder: null,
    text: "总结一下这个文件夹。",
  },
  {
    id: "en-scope-whats-here",
    language: "en",
    situation: "scope",
    folder: 2,
    text: "What's in here?",
  },
  {
    id: "en-note-whats-here",
    language: "en",
    situation: "note",
    folder: 2,
    text: "Tell me what's in here.",
  },
  {
    id: "en-library-summarise",
    language: "en",
    situation: "library",
    folder: 1,
    text: "Summarise this folder.",
  },
  {
    id: "en-library-whats-here",
    language: "en",
    situation: "library",
    folder: 0,
    text: "What's in here?",
  },
  {
    id: "en-note-default-summarise",
    language: "en",
    situation: "note-default",
    folder: 1,
    text: "Summarise this folder.",
  },
  {
    id: "en-note-default-whats-here",
    language: "en",
    situation: "note-default",
    folder: 2,
    text: "What's in here?",
  },
  {
    id: "zh-scope-whats-here",
    language: "zh-CN",
    situation: "scope",
    folder: 2,
    text: "这里面的资料讲了什么？",
  },
  {
    id: "zh-note-whats-here",
    language: "zh-CN",
    situation: "note",
    folder: 2,
    text: "告诉我这里面有什么。",
  },
  {
    id: "zh-library-summarise",
    language: "zh-CN",
    situation: "library",
    folder: 1,
    text: "总结一下这个文件夹。",
  },
  {
    id: "zh-library-whats-here",
    language: "zh-CN",
    situation: "library",
    folder: 0,
    text: "这里面有什么？",
  },
  {
    id: "zh-note-default-summarise",
    language: "zh-CN",
    situation: "note-default",
    folder: 1,
    text: "总结一下这个文件夹。",
  },
  {
    id: "zh-note-default-whats-here",
    language: "zh-CN",
    situation: "note-default",
    folder: 2,
    text: "这里面有什么？",
  },
];

interface Billed {
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
}

const priced = (each: Billed): number =>
  PRICE
    ? costOf(
        {
          inputTokens: each.input,
          cachedInputTokens: each.cacheRead,
          cacheWriteTokens: each.cacheWrite,
          outputTokens: each.output,
        },
        PRICE,
        new Date(),
        { cacheWrites: true },
      )
    : Number.NaN;

interface Run {
  request: Request;
  asked: boolean;
  question: string;
  summarised: boolean;
  outside: string[];
  reply: string;
  dollars: number;
}

const stripped = (text: string) => text.replace(/\s+/g, " ").trim();

/** What a run did, read from its Answer and from the question it stopped at, if it asked. */
function judged(
  request: Request,
  answer: ConversationAnswer,
  pages: readonly { text: string; cited: readonly string[] }[],
  asked: string | null,
  library: { folders: { name: string; files: { name: string }[] }[]; loose: { name: string } },
  idsToNames: Map<string, string>,
): Omit<Run, "dollars"> {
  const target = request.folder === null ? [] : (library.folders[request.folder]?.files ?? []);
  const targetNames = new Set(target.map((file) => file.name));
  const allNames = [
    ...library.folders.flatMap((folder) => folder.files.map((file) => file.name)),
    library.loose.name,
  ];
  const cited = new Set(
    [
      ...answer.citations.map((citation) => citation.documentId),
      ...pages.flatMap((page) => page.cited),
    ].flatMap((id) => {
      const name = idsToNames.get(id);
      return name ? [name] : [];
    }),
  );
  const written = [answer.text, ...pages.map((page) => page.text)].join("\n");
  const named = new Set(allNames.filter((name) => written.includes(name)));
  const used = new Set([...cited, ...named]);
  const inside = [...used].filter((name) => targetNames.has(name));
  const outside = [...used].filter((name) => !targetNames.has(name));
  const endsAsking = /[?？]\s*$/.test(answer.text.trim());
  const question = asked ?? (inside.length === 0 && endsAsking ? answer.text : "");
  return {
    request,
    asked: question !== "",
    question: stripped(question),
    summarised: target.length > 0 ? inside.length >= Math.ceil(target.length / 2) : used.size > 0,
    outside: request.situation === "none" ? [] : outside,
    reply: stripped(written),
  };
}

const limited = Number.isFinite(MAX_USD);
if (limited && !PRICE)
  throw new Error(`INCARNAMIND_LIVE_MAX_USD needs a model the catalog prices; ${MODEL} isn't.`);

describe("'This folder' in the assistant, live", () => {
  test.skipIf(KEY === undefined)(
    `${MODEL}: a Folder in scope, the Library, or a Note in front is carried out and asks nothing; with none it asks, naming them`,
    { timeout: 3 * 60 * 60_000 },
    async () => {
      const tokens = watchTokens();
      const runs: Run[] = [];
      const report: string[] = [`## ${MODEL}`];
      const keep = async () => {
        const resolvable = runs.filter((run) => run.request.situation !== "none");
        const ambiguous = runs.filter((run) => run.request.situation === "none");
        const rate = (count: number, of: number) => `${count} of ${of}`;
        report.push(
          `needless questions: ${rate(resolvable.filter((run) => run.asked).length, resolvable.length)}`,
          `wrong Folder or Documents outside the Folder: ${rate(resolvable.filter((run) => run.outside.length > 0).length, resolvable.length)}`,
          `not carried out on the Folder: ${rate(resolvable.filter((run) => !run.asked && !run.summarised).length, resolvable.length)}`,
          `asked which Folder when nothing told: ${rate(ambiguous.filter((run) => run.asked).length, ambiguous.length)}`,
          `spend: $${runs.reduce((total, run) => total + run.dollars, 0).toFixed(4)}`,
        );
        process.stdout.write(`${report.join("\n")}\n`);
        if (process.env.INCARNAMIND_LIVE_REPORT) {
          await appendFile(process.env.INCARNAMIND_LIVE_REPORT, `${report.join("\n")}\n\n`);
        }
      };
      onTestFinished(keep);

      const libraries = new Map<Words, Awaited<ReturnType<typeof open>>>();
      async function open(language: Words) {
        const core = startCore(await createTempDataFolder(), {
          createChatModel: tokens.chatModels(createAiSdkChatModel),
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
        const library = LIBRARIES[language];
        const folders: LibraryGroup[] = [];
        const idsToNames = new Map<string, string>();
        for (const folder of library.folders) {
          const made = await core.createLibraryGroup({ name: folder.name, description: "" });
          folders.push(made);
          const documents = await addAndProcess(
            core,
            await Promise.all(
              folder.files.map((file) =>
                writeSourceFile(sources, `${file.name}.txt`, `${file.text}\n`),
              ),
            ),
          );
          for (const document of documents) {
            await core.assignDocumentGroup(document.id, made.id);
            idsToNames.set(document.id, document.name);
          }
        }
        const [loose] = await addAndProcess(core, [
          await writeSourceFile(sources, `${library.loose.name}.txt`, `${library.loose.text}\n`),
        ]);
        if (loose) idsToNames.set(loose.id, loose.name);
        return { core, folders, idsToNames, library };
      }

      async function ask(
        core: Core,
        request: Request,
        folders: LibraryGroup[],
      ): Promise<{
        answer: ConversationAnswer;
        question: string | null;
        pages: { text: string; cited: string[] }[];
      }> {
        const target = request.folder === null ? null : (folders[request.folder] ?? null);
        const withNote = request.situation === "note" || request.situation === "note-default";
        const mind =
          withNote && target
            ? await core.createMind({
                title: request.language === "en" ? "Plan" : "计划",
                folderId: target.id,
              })
            : null;
        const withScope = request.situation === "scope" || request.situation === "note-default";
        const scope =
          withScope && target
            ? { folderIds: [target.id], tagIds: [], documentIds: [] }
            : { folderIds: [], tagIds: [], documentIds: [] };
        let question: string | null = null;
        const stopListening = core.on("question.asked", (asked) => {
          question = [
            asked.question.question,
            ...asked.question.options.map((option) => option.label),
          ].join(" | ");
          // Nobody answers it: the Answer is stopped so the wait for its ending ends.
          if (asked.conversationId) {
            void core.stopConversationAnswer({
              conversationId: asked.conversationId,
              answerId: asked.answerId,
            });
          }
        });
        const result = await core.askInConversation({
          text: request.text,
          ...(mind && { mindId: mind.id }),
          ...(request.situation === "library" && target && { folderInFrontId: target.id }),
          scope,
        });
        if (!result.asked) throw new Error(`Not asked: ${JSON.stringify(result)}`);
        try {
          await new Promise<void>((resolve) => {
            const stops = [
              core.on("answer.finished", ({ answerId }) => answerId === result.answerId && done()),
              core.on("answer.failed", ({ answerId }) => answerId === result.answerId && done()),
            ];
            function done() {
              for (const stop of stops) stop();
              resolve();
            }
          });
        } finally {
          stopListening();
        }
        const { messages } = await core.getConversation(result.conversation.id);
        const answer = messages.find((message) => message.id === result.answerId);
        if (answer?.kind !== "answer") throw new Error("No Answer.");
        // A summary may be written into a Note, the one in front or a new one, not into the reply:
        // only the Notes this Answer wrote into count, never what an earlier request left there.
        const written = [
          ...new Set(
            answer.toolCalls.flatMap((call) => (call.mindChange ? [call.mindChange.mindId] : [])),
          ),
        ];
        const pages = await Promise.all(
          written.map(async (mindId) => {
            const node = readMind(await connectToMind(core, mindId));
            const cited: string[] = [];
            node.descendants((child) => {
              if (child.type.name === CITATION_NODE) cited.push(String(child.attrs.documentId));
            });
            return { text: node.textContent, cited };
          }),
        );
        return { answer, question, pages };
      }

      let spent = 0;
      for (let round = 0; round < RUNS; round++) {
        for (const request of REQUESTS) {
          if (spent >= MAX_USD) {
            report.push(`stopped at $${spent.toFixed(4)}: the cap of $${MAX_USD}`);
            break;
          }
          let library = libraries.get(request.language);
          if (!library) {
            library = await open(request.language);
            libraries.set(request.language, library);
          }
          tokens.take();
          const { answer, question, pages } = await ask(library.core, request, library.folders);
          const billed = tokens.take().map(
            (each): Billed => ({
              input: each.uncached + each.cacheRead + each.cacheWrite,
              cacheRead: each.cacheRead,
              cacheWrite: each.cacheWrite,
              output: each.output,
            }),
          );
          const dollars = billed.reduce((total, each) => total + priced(each), 0);
          spent += Number.isNaN(dollars) ? 0 : dollars;
          const run = {
            ...judged(request, answer, pages, question, library.library, library.idsToNames),
            dollars: Number.isNaN(dollars) ? 0 : dollars,
          };
          runs.push(run);
          report.push(
            `- ${request.id}: ${run.asked ? `ASKED "${run.question}"` : run.summarised ? "carried out" : "did neither"}${run.outside.length > 0 ? `; Documents outside: ${run.outside.join(", ")}` : ""} ($${run.dollars.toFixed(4)})\n  ${run.reply.slice(0, 240)}`,
          );
        }
      }

      for (const run of runs) {
        const { request } = run;
        if (request.situation === "none") {
          expect(run.asked, `${request.id} should ask which Folder`).toBe(true);
          const folders = LIBRARIES[request.language].folders.map((folder) => folder.name);
          expect(
            folders.filter((name) => run.question.includes(name)).length,
            `${request.id} should name the Folders it could mean`,
          ).toBeGreaterThanOrEqual(2);
        } else {
          expect(run.asked, `${request.id} asked: ${run.question}`).toBe(false);
          expect(run.outside, `${request.id} used Documents outside the Folder`).toEqual([]);
          expect(run.summarised, `${request.id} did not work on the Folder`).toBe(true);
        }
      }
      expect(runs.length).toBeGreaterThan(0);
    },
  );
});
