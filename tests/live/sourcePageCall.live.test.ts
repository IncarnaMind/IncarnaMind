/**
 * The assistant's call for "the source is the lease, p. 4" on a real model (#1554): whether it
 * sends the page (`page` of `run_command`) for a page the User names and none for one they don't.
 * The window's command list is the renderer's own, as a window with the Note in front offers it;
 * the window is this test, which answers that the command ran and keeps its request. Runs only with
 * INCARNAMIND_LIVE_ANTHROPIC_KEY (the model is INCARNAMIND_LIVE_ANTHROPIC_MODEL, Claude Haiku 5.5
 * by default), or, with INCARNAMIND_LIVE_PROVIDER=deepseek, INCARNAMIND_LIVE_DEEPSEEK_KEY (DeepSeek
 * V4.1 Flash, deepseek-flash); INCARNAMIND_LIVE_RUNS asks of each request (5);
 * INCARNAMIND_LIVE_REPORT keeps one line a ask. Written before it was run, the bars (written 2026-11-17, stop US$0.15):
 * - Each request that names page 4, in English ("p. 4", "page 4") and in Chinese (第4页, 第 4 页),
 *   sends page 4 on the Lease's check.chooseCitation in every ask.
 * - The request that names no page sends none, and every ask runs check.chooseCitation on the Lease.
 * - A request whose command ended in anything else, or which ran no command, is a miss, said by what
 *   it was; a refused, failed or timed out request makes the run void.
 */
import { appendFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import type { Core, WindowCommandRequest } from "../../src/core";
import { catalogProvider } from "../../src/core/providers/catalog/providers";
import { createAiSdkChatModel } from "../../src/core/providers/models";
import type { OfferedCommand } from "../../src/shared/commands";
import { askAssistant } from "../helpers/assistant";
import { createTempDataFolder, startCore } from "../helpers/core";
import { addAndProcess, writeSourceFile } from "../helpers/documents";
import { connectToMind } from "../helpers/mindClient";
import { note, writeMind } from "../helpers/minds";
import { buildPdf } from "../helpers/pdf";

const DEEPSEEK = process.env.INCARNAMIND_LIVE_PROVIDER === "deepseek";
const KEY = DEEPSEEK
  ? process.env.INCARNAMIND_LIVE_DEEPSEEK_KEY
  : process.env.INCARNAMIND_LIVE_ANTHROPIC_KEY;
const MODEL = DEEPSEEK
  ? (process.env.INCARNAMIND_LIVE_DEEPSEEK_MODEL ??
    (catalogProvider("deepseek")?.roles.quickTasks as string))
  : (process.env.INCARNAMIND_LIVE_ANTHROPIC_MODEL ??
    (catalogProvider("anthropic")?.roles.quickTasks as string));
const RUNS = Number(process.env.INCARNAMIND_LIVE_RUNS ?? "5") || 5;
const REPORT = process.env.INCARNAMIND_LIVE_REPORT;
const WINDOW = "live-window";

/** The renderer's command list, as a window with this note in front offers it. */
async function windowCommandsFor(core: Core, mindId: string): Promise<OfferedCommand[]> {
  const bridge = new Proxy({}, { get: () => () => () => undefined });
  (globalThis as unknown as { window: unknown }).window = {
    incarnamind: bridge,
    incarnamindFiles: bridge,
  };
  await import("../../src/renderer/src/commands/app");
  const { useAppStore } = await import("../../src/renderer/src/store");
  const { offeredCommands } = await import("../../src/renderer/src/assistantWindow");
  useAppStore.setState({
    minds: await core.listMinds(),
    documents: await core.listDocuments(),
    layout: {
      groups: [
        {
          id: "group",
          tabs: [{ id: "tab", item: { kind: "mind", mindId } }],
          activeTabId: "tab",
          width: 1,
        },
      ],
      focusedGroupId: "group",
      reopenable: 0,
    } as never,
  });
  return offeredCommands(mindId);
}

const SETS = {
  // The first phrasing, a statement about the source. Haiku 5.5 never ran the command in 25 asks:
  // 0 of 20 asks before the command had a purpose line, 0 of 5 after it (US$0.04 in all). It read
  // the Lease for the page instead.
  first: [
    { text: "The source is the Lease, p. 4", page: 4 },
    { text: "The source is the Lease, page 4", page: 4 },
    { text: "出处是“Lease”，第4页", page: 4 },
    { text: "出处是Lease文档的第 4 页", page: 4 },
    { text: "The source is the Lease", page: undefined },
  ],
  // The second, written 2026-11-17 before it was run: what a User says of the sentence in front of
  // them, as a request. Its first run (1 ask each, US$0.007) used a Note sentence the Lease doesn't
  // say and a Lease with one page: the "Open page 4 … so I can pick" requests ran the command with
  // page 4 (2 of 2), the "Point this sentence to" ones were declined for good reason (sentence
  // unrelated, no page 4). The fixture is now a five-page Lease PDF whose page 4 says the sentence.
  second: [
    { text: "Open page 4 of the Lease so I can pick the source for this sentence.", page: 4 },
    { text: "Point this sentence to the Lease, p. 4.", page: 4 },
    { text: "把这句话的出处指向 Lease 的第4页。", page: 4 },
    { text: "请打开 Lease 的第 4 页，我来选这句话的出处。", page: 4 },
    { text: "Point this sentence to the Lease.", page: undefined },
    { text: "把这句话的出处指向 Lease。", page: undefined },
  ],
  // The third, written 2026-11-17 before it was run, after the second showed the "Point this
  // sentence to" requests are answered by the assistant citing the sentence itself (10 of 10 asks,
  // no command) while the "Open … so I can pick" ones run it: the no-page twins of the latter.
  third: [
    { text: "Open the Lease so I can pick the source for this sentence.", page: undefined },
    { text: "请打开 Lease，我来选这句话的出处。", page: undefined },
  ],
} as const;
const REQUESTS =
  SETS[(process.env.INCARNAMIND_LIVE_SET as keyof typeof SETS | undefined) ?? "first"];

describe("the source's page in the assistant's call, live", () => {
  test.skipIf(KEY === undefined)(
    `${MODEL}: ${RUNS} asks of each request`,
    { timeout: 3_600_000 },
    async () => {
      const lines: string[] = [];
      let spent = 0;
      for (const request of REQUESTS) {
        const sent: (number | undefined)[] = [];
        let misses = 0;
        for (let run = 0; run < RUNS; run++) {
          const core = startCore(await createTempDataFolder(), {
            createChatModel: createAiSdkChatModel,
          });
          core.on(
            "consent.requested",
            (asked) => void core.respondToConsent(asked.requestId, true),
          );
          const windowRequests: WindowCommandRequest[] = [];
          core.on("command.windowRun", (asked) => {
            if (asked.clientId !== WINDOW) return;
            windowRequests.push(asked);
            void core.answerWindowCommand(asked.requestId, { ran: true, changed: false });
          });
          await core.saveChatProvider({
            kind: DEEPSEEK ? "deepseek" : "anthropic",
            apiKey: KEY ?? "",
            modelId: MODEL,
          });
          const sources = await createTempDataFolder();
          await addAndProcess(core, [
            await writeSourceFile(
              sources,
              "Lease.pdf",
              buildPdf(
                [
                  "Lease: parties and term.",
                  "Lease: the premises.",
                  "Lease: services.",
                  "The rent is 900 euros a month.",
                  "Lease: signatures.",
                ].map((line) => ({ lines: [line] })),
              ),
            ),
            await writeSourceFile(sources, "Q3 commentary.md", "# Q3\n\nRevenue grew 4%.\n"),
          ]);
          const mind = await core.createMind({ title: "Notes" });
          writeMind(await connectToMind(core, mind.id), [note("The rent is 900 euros a month.")]);
          const answer = await askAssistant(core, {
            text: request.text,
            mindId: mind.id,
            commands: await windowCommandsFor(core, mind.id),
            clientId: WINDOW,
          });
          const ran = windowRequests.filter((each) => each.command === "check.chooseCitation");
          const onLease = ran.length === 1 && ran[0]?.targets.length === 1;
          if (!onLease) {
            misses++;
            lines.push(
              `  miss: ${JSON.stringify(
                answer.toolCalls
                  .filter((call) => call.source === "commands")
                  .map((call) => call.command?.command ?? call.source),
              )} ${JSON.stringify(windowRequests.map((each) => each.command))} “${answer.text.slice(0, 160).replace(/\s+/g, " ")}”`,
            );
          }
          sent.push(ran[0]?.page);
          const { spent: cost } = await core.getCostSummary();
          spent += cost[0]?.amount ?? 0;
          core.close();
        }
        const right = sent.filter((page) => page === request.page).length;
        lines.push(
          `${request.text} → page ${request.page ?? "none"}: ${right} of ${RUNS} right, sent ${JSON.stringify(sent)}, ${misses} not on the Lease`,
        );
      }
      lines.push(`spent ${spent}`);
      console.log(lines.join("\n"));
      if (REPORT) appendFileSync(REPORT, `${lines.join("\n")}\n`);
      expect(lines.length).toBeGreaterThan(1);
    },
  );
});
