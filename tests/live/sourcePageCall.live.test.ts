/**
 * The assistant's call for "the source is the lease, p. 4" on a real model (#1554): whether it
 * sends the page (`page` of `run_command`) for a page the User names and none for one they don't.
 * The window is this test, which answers that the command ran and keeps its request. Runs only with
 * INCARNAMIND_LIVE_ANTHROPIC_KEY (the model is INCARNAMIND_LIVE_ANTHROPIC_MODEL, Claude Haiku 5.5
 * by default), INCARNAMIND_LIVE_RUNS asks of each request (5); INCARNAMIND_LIVE_REPORT keeps one
 * line a ask. Written before it was run, the bars (written 2026-11-17, stop US$0.15):
 * - Each request that names page 4, in English ("p. 4", "page 4") and in Chinese (第4页, 第 4 页),
 *   sends page 4 on the Lease's check.chooseCitation in every ask.
 * - The request that names no page sends none, and every ask runs check.chooseCitation on the Lease.
 * - A request whose command ended in anything else, or which ran no command, is a miss, said by what
 *   it was; a refused, failed or timed out request makes the run void.
 */
import { appendFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import type { WindowCommandRequest } from "../../src/core";
import { catalogProvider } from "../../src/core/providers/catalog/providers";
import { createAiSdkChatModel } from "../../src/core/providers/models";
import type { OfferedCommand } from "../../src/shared/commands";
import { askAssistant } from "../helpers/assistant";
import { createTempDataFolder, startCore } from "../helpers/core";
import { addAndProcess, writeSourceFile } from "../helpers/documents";

const KEY = process.env.INCARNAMIND_LIVE_ANTHROPIC_KEY;
const MODEL =
  process.env.INCARNAMIND_LIVE_ANTHROPIC_MODEL ??
  (catalogProvider("anthropic")?.roles.quickTasks as string);
const RUNS = Number(process.env.INCARNAMIND_LIVE_RUNS ?? "5") || 5;
const REPORT = process.env.INCARNAMIND_LIVE_REPORT;
const WINDOW = "live-window";

const entry = (id: OfferedCommand["id"], label: string, more: Partial<OfferedCommand> = {}) => ({
  id,
  label,
  purpose: null,
  on: null,
  deletes: false,
  final: false,
  recording: null,
  yours: null,
  ...more,
});

const COMMANDS: OfferedCommand[] = [
  entry("check.chooseCitation", "Choose the Citation…", { on: ["document"] }),
  entry("check.againstDocument", "Check against a Document…", { on: ["document", "folder"] }),
  entry("document.openBeside", "Open in a split on the right", { on: ["document"] }),
  entry("mind.check", "Check"),
];

const REQUESTS = [
  { text: "The source is the Lease, p. 4", page: 4 },
  { text: "The source is the Lease, page 4", page: 4 },
  { text: "出处是“Lease”，第4页", page: 4 },
  { text: "出处是Lease文档的第 4 页", page: 4 },
  { text: "The source is the Lease", page: undefined },
] as const;

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
          await core.saveChatProvider({ kind: "anthropic", apiKey: KEY ?? "", modelId: MODEL });
          const sources = await createTempDataFolder();
          await addAndProcess(core, [
            await writeSourceFile(
              sources,
              "Lease.md",
              "# Lease\n\nThe rent is 900 euros a month.\n",
            ),
            await writeSourceFile(sources, "Q3 commentary.md", "# Q3\n\nRevenue grew 4%.\n"),
          ]);
          const mind = await core.createMind({ title: "Notes" });
          await askAssistant(core, {
            text: request.text,
            mindId: mind.id,
            commands: COMMANDS,
            clientId: WINDOW,
          });
          const ran = windowRequests.filter((each) => each.command === "check.chooseCitation");
          const onLease = ran.length === 1 && ran[0]?.targets.length === 1;
          if (!onLease) misses++;
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
