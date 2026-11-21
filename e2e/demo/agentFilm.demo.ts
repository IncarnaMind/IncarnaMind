/**
 * Records one take of the README film of an agent writing into IncarnaMind (#1812): the built
 * app's window, frame by frame at twice the pixel density, and beside it on the same clock what
 * Claude Code did, as `claude -p` streams it. No AI model is set up in the app, as a User with only
 * their own agent has it: Claude Code writes a credit memo on Northwind Retail from the User's
 * files, with the chart the request names, and checks it itself, sentence by sentence against the
 * Documents. The User opens the note and looks at the chart. When the check marked a sentence, the
 * User asks Claude Code to fix it from the mark's card, and Claude Code gets the one line the app
 * wrote for it. When it marked nothing, the take ends after the note opens; every take is kept
 * for the tally. `DEMO_APP_MODEL=1` sets a model up in the app as well: the request then asks for
 * IncarnaMind's own check, and the User runs it again after the fix. The film is cut from these
 * afterwards, so this file draws nothing but the pointer's arrow, which a page's frames don't
 * carry. Test Documents only. Build the test app first (`npx electron-vite build --mode test`),
 * then:
 *
 *   ANTHROPIC_API_KEY=… DEMO_OUT=<folder> DEMO_LANGUAGE=en npx playwright test \
 *     -c e2e/demo/playwright.demo.config.ts agentFilm
 *
 * `DEMO_REHEARSE=1` tries the steps with no writer and no check by a model: a short memo is
 * written and one sentence reported as overstated over the agent's own connection. A rehearsal is
 * never a take. `DEMO_OUT` gets the app's frames with their times (`app/`), each turn's stream
 * with the time each line came (`turn-N.stream.jsonl`, `turn-N.times.json`), the take's marks and
 * outcome (`take.json`), the app's own log (`app.log`) and pictures of each step. Nothing the app
 * is asked to open reaches this computer: the test build records links instead of opening them.
 */
import { cp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { expect, test } from "@playwright/test";
import type { AgentLaunch, CoreBridge } from "../../src/core/api";
import { createDataFolder, launchApp, removeDataFolder, setLanguage, urlsOpened } from "../app";
import { writeNorthwindPapers } from "./agentDocuments";
import {
  atSurface,
  type Box,
  claudeCode,
  film,
  keepStream,
  pointer,
  type StreamEvent,
  SURFACE,
  sleep,
  type Turn,
} from "./agentTake";
import { chooseSonnetEverywhere, connectClaude, spent } from "./workspace";

const language = (process.env.DEMO_LANGUAGE ?? "en") as "en" | "zh-CN";
const OUT = process.env.DEMO_OUT ?? "";
const WRITER = process.env.DEMO_WRITER ?? "claude-haiku-5-5";
const REHEARSAL = process.env.DEMO_REHEARSE === "1";
/** A model set up in the app too, for its own check: off, as a User with only their own agent has it. */
const APP_MODEL = process.env.DEMO_APP_MODEL === "1";
const SHIPPED = resolve(__dirname, "../../resources/examples");
/** The verdicts of IncarnaMind's check the film is about: a sentence the Documents don't bear out. */
const MARKED = /Overstated|Partly supported|Contradicted|夸大|部分有依据|与文档矛盾/;

const WORDS = {
  en: {
    folders: { credit: "Northwind Retail", contracts: "Contracts", reports: "Market reports" },
    request:
      "In IncarnaMind, write a credit memo on Northwind Retail for Monday's credit committee from my files, with a chart of its leverage against the covenant limit, then check it.",
    requestOwnCheck:
      "In IncarnaMind, write a credit memo on Northwind Retail for Monday's credit committee from my files, with a chart of its leverage against the covenant limit, then run IncarnaMind's own check on it.",
    checkAgain: "Check every sentence again",
  },
  "zh-CN": {
    folders: { credit: "Northwind Retail", contracts: "合同", reports: "政府工作报告" },
    request:
      "请在 IncarnaMind 里根据我的文件，为周一的信贷委员会写一份关于 Northwind Retail 的信贷备忘录，配一张杠杆率对照契约上限的图表，写完后核对一遍。",
    requestOwnCheck:
      "请在 IncarnaMind 里根据我的文件，为周一的信贷委员会写一份关于 Northwind Retail 的信贷备忘录，配一张杠杆率对照契约上限的图表，写完后请用 IncarnaMind 自己的核对检查一遍。",
    checkAgain: "重新核对每一句",
  },
} as const;

/** What a rehearsal writes in the writer's place. */
const REHEARSED = {
  title: "Northwind Retail: rehearsal memo",
  wrong: "Net debt doubled over the half.",
  memo: [
    "Northwind Retail reported its first-half results for 2026 in the summer.",
    "Net debt doubled over the half.",
    "The amendment letter of 30 June 2026 lowers the leverage limit to 3.25:1 for quarter dates on or after 31 December 2026.",
    "Management now expects full-year underlying EBITDA of £400 million to £420 million.",
    "The lender presentation gives forecasts that have not been audited.",
    "The committee should ask for the next compliance certificate before approving further exposure.",
  ],
};

test.describe.configure({ mode: "serial" });

test(`records a take of the agent film in ${language}`, async () => {
  test.setTimeout(60 * 60_000);
  if (!OUT) throw new Error("Set DEMO_OUT to the folder the take goes in.");
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("Set ANTHROPIC_API_KEY.");
  const words = WORDS[language];
  const request = APP_MODEL ? words.requestOwnCheck : words.request;
  await mkdir(join(OUT, "shots"), { recursive: true });
  const dataDir = await createDataFolder();
  const home = await createDataFolder();
  const papers = await createDataFolder();
  const started = Date.now();
  const marks: Record<string, number> = {};
  const mark = (name: string) => {
    marks[name] = (Date.now() - started) / 1000;
  };
  const rects: Record<string, Box> = {};
  const take: Record<string, unknown> = {
    language,
    writer: REHEARSAL ? "rehearsal" : WRITER,
    appModel: APP_MODEL,
    surface: SURFACE,
    started,
    outcome: "unfinished",
  };
  const { app, window } = await launchApp(dataDir, { real: ["embedder"], sandboxed: true, home });
  const shot = (name: string) =>
    window.screenshot({ path: join(OUT, "shots", `${name}.png`) }).catch(() => undefined);
  let stopFilm: (() => Promise<void>) | undefined;
  try {
    await atSurface(app, window);
    if (language !== "en") await setLanguage(window, language);
    if (APP_MODEL) {
      await connectClaude(window);
      await chooseSonnetEverywhere(window);
    }

    const shipped = async (name: string) => {
      const folder = join(SHIPPED, name, language);
      return (await readdir(folder)).sort().map((each) => join(folder, each));
    };
    const agreement = (await shipped("credit")).filter((path) =>
      /facilities agreement|贷款协议/.test(path),
    );
    const library = {
      credit: [...(await writeNorthwindPapers(papers, language)), ...agreement],
      contracts: await shipped("contracts"),
      reports: await shipped("reports"),
    };
    take.papers = library.credit.map((path) => path.split("/").at(-1));
    const creditId = await window.evaluate(
      async ({ names, paths }) => {
        const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
        const make = async (name: string, inside: string[]) => {
          const made = await core.createLibraryGroup({ name, description: "" });
          await core.addDocuments(inside, { groupId: made.id });
          return made.id;
        };
        const credit = await make(names.credit, paths.credit);
        await make(names.contracts, paths.contracts);
        await make(names.reports, paths.reports);
        return credit;
      },
      { names: words.folders, paths: library },
    );
    const total = library.credit.length + library.contracts.length + library.reports.length;
    await expect
      .poll(
        () =>
          window.evaluate(async (expected) => {
            const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
            const documents = await core.listDocuments();
            const found = await core.searchDocumentText("Northwind");
            const ready =
              documents.length === expected && documents.every((each) => each.status === "ready");
            return ready ? new Set(found.map((match) => match.documentId)).size : -1;
          }, total),
        { timeout: 900_000, intervals: [1000] },
      )
      .toBeGreaterThanOrEqual(4);

    const launch: AgentLaunch = await window.evaluate(async (folderId) => {
      const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
      await core.setAgentsEnabled(true);
      const connected = await core.connectAgent({
        name: "Claude Code",
        client: "claude-code",
        folderIds: [folderId],
        propose: true,
      });
      return connected.launch;
    }, creditId);
    const mcpFile = join(home, "mcp.json");
    await writeFile(mcpFile, JSON.stringify({ mcpServers: { incarnamind: launch } }), {
      mode: 0o600,
    });
    const written = claudeCode({ home, mcpFile, key, model: WRITER, out: OUT });
    type Call = (name: string, input: Record<string, unknown>) => Promise<Record<string, unknown>>;
    /** A rehearsal's turn: Tools called over the agent's own connection, kept as a stream is. */
    const rehearsed = async (
      prompt: string,
      label: string,
      calls: (call: Call) => Promise<string>,
    ): Promise<Turn> => {
      const began = Date.now();
      const result: Turn = {
        prompt,
        started: began,
        events: [],
        checks: [],
        cost: 0,
        turns: null,
        seconds: 0,
        refused: [],
        stderr: "",
      };
      const kept: string[] = [];
      const times: number[] = [];
      const said = (kind: StreamEvent["kind"], text: string) => {
        const at = (Date.now() - began) / 1000;
        result.events.push({ at, kind, text });
        times.push(at);
        const part =
          kind === "tool"
            ? { type: "tool_use", name: `mcp__incarnamind__${text}` }
            : { type: "text", text };
        kept.push(JSON.stringify({ type: "assistant", message: { content: [part] } }));
      };
      const agent = new Client({ name: "rehearsal", version: "1.0.0" });
      await agent.connect(new StdioClientTransport({ ...launch, stderr: "pipe" }));
      try {
        await sleep(1500);
        const reply = await calls(async (name, input) => {
          said("tool", name);
          const answer = await agent.callTool({ name, arguments: input });
          await sleep(1200);
          return (answer.structuredContent ?? {}) as Record<string, unknown>;
        });
        said("text", reply);
      } finally {
        await agent.close();
      }
      result.seconds = (Date.now() - began) / 1000;
      await keepStream(OUT, label, kept, times);
      return result;
    };

    // The search model downloads on first use: film once the footer has nothing to say.
    await expect
      .poll(async () => ((await window.getByTestId("sidebar-status").textContent()) ?? "").trim(), {
        timeout: 1_200_000,
        intervals: [2000],
      })
      .toBe("");
    // The window as the film has it: the Library open, the sidebar and the assistant put away.
    await window.getByTestId("open-library").click();
    const assistant = window.getByTestId("assistant");
    if ((await assistant.count()) > 0 && (await assistant.getAttribute("data-folded")) !== "true")
      await window
        .getByTestId("assistant-fold")
        .click()
        .catch(() => undefined);
    await window.getByTestId("sidebar-toggle").first().click();
    await sleep(600);
    const { glide, boxOf, click, leave } = await pointer(window, rects);
    const labels = () =>
      window
        .getByTestId("claim-mark")
        .evaluateAll((all) => all.map((each) => each.getAttribute("aria-label") ?? ""));
    const minds = () =>
      window.evaluate(async () =>
        (await (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.listMinds()).map(
          (each) => ({ id: each.id, title: each.title || each.autoTitle }),
        ),
      );

    stopFilm = await film(window, join(OUT, "app"));
    const finish = async (outcome: string) => {
      take.outcome = outcome;
      mark("end");
      take.appSpent = await spent(window);
    };
    await shot("01-library");
    // As long as the User takes to type the request: the film shows it typed before the turn.
    await sleep(REHEARSAL ? 3000 : 3000 + (request.length / 9) * 1000);

    mark("turn-1");
    const first = REHEARSAL
      ? await rehearsed(request, "turn-1", async (call) => {
          const made = await call("create_mind", {
            title: REHEARSED.title,
            markdown: REHEARSED.memo.join(" "),
          });
          const mindId = String(made.mindId);
          const asked = await call("check_mind_yourself", { mindId });
          const sentences = asked.sentences as { n: number; text: string }[];
          const wrong = sentences.find((each) => each.text === REHEARSED.wrong);
          await call("report_check", {
            mindId,
            task: asked.task,
            results: [{ n: wrong?.n, verdict: "overstated", explanation: "A rehearsal's mark." }],
          });
          return "Rehearsal: the memo is written and one sentence is reported as overstated.";
        })
      : await written(request, "turn-1");
    mark("turn-1-end");
    take.turn1 = first;
    take.checkTools = first.events.filter((each) => /check/.test(each.text)).map((e) => e.text);
    await sleep(2500);
    take.minds = await minds();
    const note = (await minds()).at(-1);
    if (!note) {
      await finish("no note");
      return;
    }
    mark("reach");
    await click(
      window.locator(`[data-testid="mind-tab"][data-mind-id="${note.id}"]`).first(),
      "tab",
    );
    mark("opened");
    await expect(window.getByTestId("mind-editor")).toBeVisible();
    await sleep(900);
    await leave();
    await sleep(3000);
    await shot("02-note");
    // The User looks at the chart they asked for, scrolling down to it when it starts below the fold.
    const chart = window.getByTestId("chart").first();
    if ((await chart.count()) > 0) {
      const found = await boxOf(chart, "chart-found");
      const bottom = found.y + Math.min(found.height, 420);
      if (bottom > 1000) {
        mark("chart-scroll");
        await glide(SURFACE.width / 2, 560);
        for (let left = bottom - 900; Math.abs(left) > 1; ) {
          const step = Math.sign(left) * Math.min(48, Math.abs(left));
          await window.mouse.wheel(0, step);
          left -= step;
          await sleep(16);
        }
        await sleep(500);
      }
      // The pointer rests beside the chart: over a bar it opens that figure's card, which covers the chart.
      await glide(SURFACE.width - 70, 560);
      await boxOf(chart, "chart");
      mark("chart");
      await sleep(2800);
      await shot("02b-chart");
    }
    const before = await labels();
    take.labelsBefore = before;
    take.noteBefore = (await window.getByTestId("mind-editor").textContent())?.slice(0, 4000);
    const ownCheck =
      REHEARSAL ||
      first.events.some(
        (each) => each.kind === "tool" && each.text === (APP_MODEL ? "check_mind" : "report_check"),
      );
    const marked = before.flatMap((label, index) => (MARKED.test(label) ? [index] : []));
    take.marked = marked.map((index) => before[index]);
    if (!ownCheck || marked.length === 0) {
      await finish(ownCheck ? "checked, nothing marked" : "check not run");
      return;
    }

    const flag = window.getByTestId("claim-mark").nth(marked[0] ?? 0);
    const found = await boxOf(flag, "mark-found");
    const middle = found.y + found.height / 2;
    if (middle > 660 || middle < 560) {
      // The User scrolls the marked sentence to the lower half of the page, where its card and the
      // count at the note's foot are in view together, the pointer over the note.
      mark("scroll");
      await glide(SURFACE.width / 2, 560);
      for (let left = middle - 610; Math.abs(left) > 1; ) {
        const step = Math.sign(left) * Math.min(48, Math.abs(left));
        await window.mouse.wheel(0, step);
        left -= step;
        await sleep(16);
      }
      await sleep(700);
    }
    mark("mark");
    await click(flag, "mark");
    const card = window.getByTestId("claim-card");
    await expect(card).toBeVisible();
    await sleep(400);
    await boxOf(card, "card");
    mark("card");
    take.card = (await card.textContent())?.slice(0, 1500) ?? null;
    await sleep(3200);
    await shot("03-card");
    const ask = window.getByTestId("claim-ask-agent").first();
    if (!(await ask.isVisible())) {
      mark("menu");
      await click(card.getByTestId("check-menu"), "menu");
      await expect(ask).toBeVisible();
      await sleep(1100);
      take.cardMenu = (await window.locator('[role="menu"]').last().textContent())?.slice(0, 400);
    }
    await shot("04-ask");
    mark("ask");
    await click(ask, "ask");
    mark("asked");
    await expect
      .poll(async () => (await urlsOpened(app)).some((url) => url.startsWith("claude-cli://")))
      .toBe(true);
    const link = (await urlsOpened(app)).find((url) => url.startsWith("claude-cli://")) ?? "";
    const line = new URL(link).searchParams.get("q") ?? "";
    take.line = line;
    if (!line) throw new Error("The link to Claude Code carried no line.");
    await expect(card).toBeHidden();
    await sleep(1500);

    // The card closed on the click: the User opens it again to see what became of the request.
    mark("mark-again");
    await click(flag, "mark-again");
    const waitingLine = card.getByTestId("claim-asked");
    await expect(waitingLine).toBeVisible();
    await boxOf(card, "card-waiting");
    mark("waiting");
    const waiting = (await waitingLine.textContent()) ?? "";
    take.waiting = waiting;
    await sleep(600);
    await leave();
    await sleep(2200);
    await shot("05-waiting");

    // The card stays open while Claude Code starts, to show the line change once it has read.
    let ended = false;
    const watched = (async () => {
      while (!ended) {
        const now = await window
          .evaluate(
            () => document.querySelector('[data-testid="claim-asked"]')?.textContent ?? null,
          )
          .catch(() => null);
        if (now !== waiting) {
          if (now !== null) {
            mark("read");
            take.read = now;
            await sleep(2400);
            await shot("06-read");
          }
          break;
        }
        await sleep(250);
      }
      if (await card.isVisible().catch(() => false)) {
        await window.keyboard.press("Escape");
        mark("card-closed");
      }
    })();
    mark("turn-2");
    const second = REHEARSAL
      ? await rehearsed(line, "turn-2", async (call) => {
          const read = await call("read_request", { note: REHEARSED.title });
          take.rehearsedRequest = read.request;
          await sleep(4000);
          return "Rehearsal: the request is read.";
        })
      : await written(line, "turn-2");
    mark("turn-2-end");
    ended = true;
    await watched;
    take.turn2 = second;
    await sleep(3000);
    await shot("07-fixed");
    take.labelsAfterFix = await labels();
    take.noteAfterFix = (await window.getByTestId("mind-editor").textContent())?.slice(0, 4000);
    if (REHEARSAL) {
      await finish("rehearsal");
      return;
    }
    if (!APP_MODEL) {
      await finish(
        (take.labelsAfterFix as string[]).some((label) => MARKED.test(label))
          ? "asked to fix, marks left"
          : "asked to fix, no mark left",
      );
      return;
    }

    // The last word is IncarnaMind's own: the User runs its check of the whole note again.
    mark("recheck");
    await window.keyboard.press("ControlOrMeta+k");
    await expect(window.getByTestId("palette-search")).toBeFocused();
    await window.keyboard.type(words.checkAgain, { delay: 110 });
    await expect(
      window.getByTestId("palette-item").filter({ hasText: words.checkAgain }).first(),
    ).toBeVisible();
    await sleep(400);
    await window.keyboard.press("Enter");
    // The command asks first when the check has a cost to estimate; otherwise it starts at once.
    const confirm = window.getByTestId("mind-check-check");
    const stop = window.getByTestId("badge-stop");
    await expect(confirm.or(stop).first()).toBeVisible({ timeout: 90_000 });
    if (await confirm.isVisible()) {
      await sleep(500);
      await click(confirm, "confirm");
      await leave();
    }
    mark("recheck-start");
    await expect(stop)
      .not.toHaveCount(0, { timeout: 20_000 })
      .catch(() => undefined);
    await expect(stop).toHaveCount(0, { timeout: 300_000 });
    mark("rechecked");
    await window.keyboard.press("Escape");
    await sleep(3500);
    await shot("08-rechecked");
    const badge = window.locator('[data-testid="check-badge"]').first();
    if ((await badge.count()) > 0) await boxOf(badge, "badge");
    const after = await labels();
    take.labelsAfter = after;
    take.badge = await badge.textContent().catch(() => null);
    take.noteAfter = (await window.getByTestId("mind-editor").textContent())?.slice(0, 4000);
    await finish(
      after.some((label) => /Needs a look|需要留意/.test(label))
        ? "fixed, marks left"
        : "fixed, clean",
    );
  } finally {
    if (marks.end === undefined) mark("end");
    await stopFilm?.().catch(() => undefined);
    take.marks = marks;
    take.rects = rects;
    await writeFile(join(OUT, "take.json"), JSON.stringify(take, null, 2));
    await app.close().catch(() => undefined);
    // The app's own log is read after every take, and goes with its data folder otherwise.
    await cp(join(dataDir, "logs", "incarnamind.log"), join(OUT, "app.log")).catch(() => undefined);
    await rm(home, { recursive: true, force: true });
    await rm(papers, { recursive: true, force: true });
    await removeDataFolder(dataDir);
  }
});
