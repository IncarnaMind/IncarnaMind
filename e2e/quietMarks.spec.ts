import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import type { Editor } from "@tiptap/core";
import type { CoreBridge } from "../src/core/api";
import {
  addDocuments,
  checkCard,
  createDataFolder,
  dismissChatSetup,
  focusSettled,
  launchApp,
  motionSettled,
  newMind,
  openPageMenu,
  paletteOffers,
  pointAndClick,
  removeDataFolder,
  setLanguage,
  setWindowSize,
  showEveryCheckResult,
  useLocalChatModel,
} from "./app";

/*
 * After a check only what needs the reader is marked (#3358): what needs a look and what wasn't
 * checked keep their marks, a Supported sentence has none, and a Passage the check found becomes a
 * Citation, in the assistant's words as the check lands and in the User's only by Add all, one
 * Undo. "Show every check result", kept with the Note, brings every mark back. The scripted model
 * (src/main/fakeChat/checks.ts) backs a sentence with the line it shares three words with and finds
 * one that shares none unsupported. Set INCARNAMIND_QUIET_STILLS to a folder to save the stills.
 */

const STILLS = process.env.INCARNAMIND_QUIET_STILLS;

const SPRING = "Spring tides happen at new moon and at full moon.";
const PILOT = "Ships longer than 120 metres need a pilot to enter the harbour.";
const PIER = "The north pier was rebuilt in 2019 after the winter storms.";
const OFFICE = "The harbour office opens at nine every weekday morning.";
const ALMANAC = ["# Harbour Almanac 2026", "", SPRING, "", PILOT, "", PIER, "", OFFICE, ""].join(
  "\n",
);

let dataDir: string;
let sources: string;
test.beforeEach(async () => {
  dataDir = await createDataFolder();
  sources = await createDataFolder();
});
test.afterEach(async () => {
  await removeDataFolder(dataDir);
  await removeDataFolder(sources);
});

const editorOf = (window: Page) => window.getByTestId("mind-editor");
const marks = (window: Page) => window.getByTestId("claim-mark");
const shownMarks = (window: Page) => window.locator('[data-testid="claim-mark"]:not([data-quiet])');

async function insert(window: Page, blocks: object[]) {
  await editorOf(window).evaluate((dom, content) => {
    const { editor } = dom as unknown as { editor: Editor };
    editor.commands.insertContentAt(0, content);
  }, blocks);
}

/** The Note's text, each Citation as its quote in brackets. */
const noteText = (window: Page) =>
  editorOf(window).evaluate((dom) => {
    const lines: string[] = [];
    (dom as unknown as { editor: Editor }).editor.state.doc.forEach((block) => {
      let line = "";
      block.forEach((node) => {
        line += node.isText ? (node.text ?? "") : `[${String(node.attrs.quote)}]`;
      });
      lines.push(line);
    });
    return lines;
  });

async function almanac(window: Page) {
  const documents = await window.evaluate(() =>
    (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.listDocuments(),
  );
  const found = documents.find((each) => each.name === "Harbour Almanac 2026");
  if (!found) throw new Error("The almanac wasn't added.");
  return found;
}

test("after a check only what needs a look is marked; the assistant's sentence gets its Citation, the User's can be cited; every result comes back and is kept", async () => {
  test.setTimeout(300_000);
  await writeFile(join(sources, "Harbour Almanac 2026.md"), ALMANAC);
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await dismissChatSetup(window);
  await useLocalChatModel(window);
  await setWindowSize(app, window, 1440, 900);
  await addDocuments(window, [join(sources, "Harbour Almanac 2026.md")]);
  const document = await almanac(window);
  await newMind(window);
  const cited = {
    type: "citation",
    attrs: {
      documentId: document.id,
      documentName: document.name,
      contentHash: document.contentHash,
      quote: SPRING,
      check: "found",
      checkReason: null,
    },
  };
  await insert(window, [
    {
      type: "paragraph",
      content: [
        { type: "text", text: "Spring tides happen at new moon and at full moon" },
        cited,
        { type: "text", text: "." },
      ],
    },
    {
      type: "paragraph",
      content: [
        {
          type: "text",
          text: "Ships longer than 120 metres need a pilot to enter.",
          marks: [{ type: "generated" }],
        },
      ],
    },
    {
      type: "paragraph",
      content: [{ type: "text", text: "The north pier was rebuilt after the winter storms." }],
    },
    {
      type: "paragraph",
      content: [{ type: "text", text: "Fishing boats pay no dues in December." }],
    },
  ]);

  const card = await checkCard(window);
  await pointAndClick(window, card.getByTestId("badge-check-mind"));
  await expect(card.getByTestId("card-foot-stop")).toHaveCount(0, { timeout: 60_000 });
  await window.keyboard.press("Escape");

  // Four sentences checked; only the one that needs a look shows its mark and its wash.
  await expect(marks(window)).toHaveCount(4);
  await expect(shownMarks(window)).toHaveCount(1);
  await expect(shownMarks(window)).toHaveAttribute("data-check", "unsupported");
  await expect(shownMarks(window)).toBeVisible();
  await expect(marks(window).and(window.locator('[data-check="supported"]'))).toHaveCount(3);
  for (const quiet of await marks(window).and(window.locator("[data-quiet]")).all())
    await expect(quiet).toBeHidden();
  await expect(editorOf(window).locator(".claim-wash--unsupported")).toHaveCount(1);
  await expect(editorOf(window).locator(".claim-wash--worked-out")).toHaveCount(0);

  // The assistant's sentence carries the Passage its check rests on as its Citation, and the quote
  // opens from it; the User's own sentence is left as written.
  const text = await noteText(window);
  expect(text[1]).toBe(`Ships longer than 120 metres need a pilot to enter[${PILOT}].`);
  expect(text[2]).toBe("The north pier was rebuilt after the winter storms.");
  const lines = editorOf(window).locator(":scope > p");
  await pointAndClick(window, lines.nth(1).getByTestId("citation"));
  await expect(window.getByTestId("citation-found-by-check")).toBeVisible();
  await expect(window.locator('[data-testid="citation-card"]')).toContainText(PILOT);
  await window.keyboard.press("Escape");

  // The foot line keeps what needs a look first and says what can be cited.
  const badge = window.getByTestId("check-badge");
  await expect(badge).toHaveAttribute("data-state", "needs-look");
  await expect(badge.getByTestId("check-badge-open")).toHaveAccessibleName(
    "Checks: 1 needs a look and 1 can be cited",
  );
  const panel = await checkCard(window);
  const row = panel.getByTestId("health-notYetCited");
  await expect(row).toContainText("1 can be cited");
  await expect(row.getByTestId("found-passages-add")).toHaveAccessibleName("Add");

  // Add all cites the User's sentence in one step, and one Undo takes it back.
  await pointAndClick(window, row.getByTestId("found-passages-add"));
  await expect
    .poll(async () => (await noteText(window))[2])
    .toBe(`The north pier was rebuilt after the winter storms[${PIER}].`);
  await expect(panel.getByTestId("health-notYetCited")).toHaveCount(0);
  await window.keyboard.press("Escape");
  await pointAndClick(window, lines.last());
  await focusSettled(window, editorOf(window));
  await window.keyboard.press("ControlOrMeta+z");
  await expect
    .poll(async () => (await noteText(window))[2])
    .toBe("The north pier was rebuilt after the winter storms.");

  // The switch is named and reached with the keyboard on the card, and brings every mark back.
  const again = await checkCard(window);
  const toggle = again.getByRole("switch", { name: "Show every check result" });
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  await toggle.focus();
  await window.keyboard.press("Space");
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  await window.keyboard.press("Escape");
  await expect(shownMarks(window)).toHaveCount(4);
  for (const each of await marks(window).all()) await expect(each).toBeVisible();

  // Kept with the Note: a restart shows every result again, and the ⋯ menu's switch says so.
  await app.close();
  const restarted = await launchApp(dataDir, { fakeChat: true });
  await setWindowSize(restarted.app, restarted.window, 1440, 900);
  await pointAndClick(restarted.window, restarted.window.getByTestId("mind-row").first());
  await expect(marks(restarted.window)).toHaveCount(4);
  await expect(shownMarks(restarted.window)).toHaveCount(4);
  const menu = await openPageMenu(restarted.window);
  const item = menu.getByRole("menuitemcheckbox", { name: "Show every check result" });
  await expect(item).toHaveAttribute("aria-checked", "true");
  await pointAndClick(restarted.window, item);
  await restarted.window.keyboard.press("Escape");
  await expect(shownMarks(restarted.window)).toHaveCount(1);
  // ⌘K finds the switch by its words too.
  expect(await paletteOffers(restarted.window, "mind.everyCheckResult", "every check result")).toBe(
    1,
  );
  await restarted.app.close();
});

/** The stills' Documents, invented, and which of them holds each line of `almanac` below. */
const STILL_DOCUMENTS = ["Harbour Almanac 2026", "Island Ferry Timetable", "Port Rules"] as const;
const STILL_SOURCES = [0, 0, 0, 1, 2, 0, 2] as const;

/** The words of the Note the stills show, invented, in both languages. */
const STILL_WORDS = {
  en: {
    title: "Harbour notes",
    almanac: [
      SPRING,
      "Neap tides happen at the first and last quarter moons.",
      "The harbour publishes the times of high water every year.",
      "The island ferry leaves at 07:30 on weekdays.",
      PILOT,
      PIER,
      OFFICE,
    ],
    paragraphs: [
      [
        ["Spring tides come at the new and the full moon.", "supported", 0],
        ["Neap tides come at the first and last quarter moons.", "supported", 1],
        ["The harbour publishes its high-water times every year.", "supported", 2],
      ],
      [
        ["The island ferry leaves at 08:30 on weekdays.", "contradicted", 3],
        ["Fishing boats pay no harbour dues in winter.", "unsupported", null],
        ["The harbour office opens at nine on weekdays.", "supported", 6],
      ],
      [
        ["Ships longer than 120 metres need a pilot to enter.", "assistant", 4],
        ["The north pier was rebuilt after the 2019 storms.", "user", 5],
        ["The harbour master retires next spring.", "not-checked", null],
      ],
    ],
    says: "The timetable says 07:30, not 08:30.",
  },
  "zh-CN": {
    title: "港口笔记",
    almanac: [
      "大潮出现在新月和满月。",
      "小潮出现在上弦月和下弦月。",
      "港口每年公布高潮时间。",
      "去海岛的渡轮工作日 07:30 开船。",
      "长度超过 120 米的船进港需要引航员。",
      "北码头在 2019 年的冬季风暴后重建。",
      "港务处工作日早上九点开门。",
    ],
    paragraphs: [
      [
        ["大潮在新月和满月时出现。", "supported", 0],
        ["小潮在上弦月和下弦月时出现。", "supported", 1],
        ["港口每年都会公布高潮时间。", "supported", 2],
      ],
      [
        ["海岛渡轮工作日 08:30 开船。", "contradicted", 3],
        ["渔船冬季不交港口费。", "unsupported", null],
        ["港务处工作日九点开门。", "supported", 6],
      ],
      [
        ["超过 120 米的船进港要请引航员。", "assistant", 4],
        ["北码头在 2019 年风暴后重建。", "user", 5],
        ["港务长明年春天退休。", "not-checked", null],
      ],
    ],
    says: "时刻表写的是 07:30，不是 08:30。",
  },
} as const;

/**
 * The Note as a check of it leaves it, in `language`: the assistant's sentence carries the Passage
 * its check found as its Citation, and the User's own Supported sentence cites nothing yet.
 */
function stillNote(
  language: "en" | "zh-CN",
  documents: readonly { id: string; name: string; contentHash: string }[],
): object[] {
  const words = STILL_WORDS[language];
  const checkedAt = new Date().toISOString();
  const passage = (line: number) => {
    const document = documents[STILL_SOURCES[line] ?? 0];
    return {
      passageId: `passage-${line}`,
      documentId: document?.id,
      documentName: document?.name,
      contentHash: document?.contentHash,
      pageFrom: null,
      pageTo: null,
      location: null,
      quote: words.almanac[line],
      check: "found",
      checkReason: null,
    };
  };
  const heading = {
    type: "heading",
    attrs: { level: 1 },
    content: [{ type: "text", text: words.title }],
  };
  return [
    heading,
    ...words.paragraphs.map((sentences, at) => ({
      type: "paragraph",
      content: sentences.flatMap(([sentence, kind, line], index) => {
        const state = kind === "assistant" || kind === "user" ? "supported" : kind;
        const evidence = line === null ? null : passage(line);
        const attrs = {
          id: `still-${at}-${index}`,
          request: "still-check",
          action: "check-against-documents",
          state,
          reason: kind === "not-checked" ? "rate-limit" : null,
          detail: null,
          text: sentence,
          evidence,
          says: kind === "contradicted" ? words.says : null,
          unsupported: null,
          calculation: null,
          citedCaseUnchecked: false,
          citedCaseFound: false,
          scope: { folderId: null, widened: false },
          versions: [],
          excluded: [],
          checkedAt,
          ...(evidence && {
            parts: [
              {
                span: { start: 0, end: sentence.length },
                kind: "fact",
                verdict: state,
                evidence: [evidence],
                says: kind === "contradicted" ? words.says : null,
                unsupported: null,
                calculation: null,
                reason: null,
                detail: null,
                versions: [],
                excluded: [],
                citedCaseUnchecked: false,
                citedCaseFound: false,
              },
            ],
          }),
        };
        const marked = (text: string) => ({
          type: "text",
          text,
          marks: [
            { type: "claimCheck", attrs },
            ...(kind === "assistant" ? [{ type: "generated" }] : []),
          ],
        });
        const cited =
          evidence !== null &&
          (kind === "supported" || kind === "contradicted" || kind === "assistant");
        const space =
          language === "en" && index < sentences.length - 1 ? [{ type: "text", text: " " }] : [];
        if (!cited) return [marked(sentence), ...space];
        return [
          marked(sentence.slice(0, -1)),
          {
            type: "citation",
            attrs: { ...evidence, ...(kind === "assistant" && { foundByCheck: true }) },
          },
          marked(sentence.slice(-1)),
          ...space,
        ];
      }),
    })),
  ];
}

test("stills of one Note after a check, with the foot line's card open and with every result shown, in English and Chinese, light and dark, at 1280 and 900 px", async () => {
  test.skip(!STILLS, "Only when stills are asked for (INCARNAMIND_QUIET_STILLS).");
  test.setTimeout(600_000);
  const folder = STILLS ?? "";
  await mkdir(folder, { recursive: true });
  for (const [at, name] of STILL_DOCUMENTS.entries()) {
    const lines = (["en", "zh-CN"] as const).flatMap((language) =>
      STILL_WORDS[language].almanac.filter((_, line) => STILL_SOURCES[line] === at),
    );
    await writeFile(
      join(sources, `${name}.md`),
      [`# ${name}`, "", ...lines.flatMap((line) => [line, ""])].join("\n"),
    );
  }
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await dismissChatSetup(window);
  await useLocalChatModel(window);
  await addDocuments(
    window,
    STILL_DOCUMENTS.map((name) => join(sources, `${name}.md`)),
  );
  const listed = await window.evaluate(() =>
    (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.listDocuments(),
  );
  const documents = STILL_DOCUMENTS.map((name) => {
    const found = listed.find((each) => each.name === name);
    if (!found) throw new Error(`${name} wasn't added.`);
    return found;
  });
  // The Note's page alone beside the sidebar, as a reader sees it.
  const fold = window.getByTestId("assistant-fold").first();
  if (await fold.isVisible()) await pointAndClick(window, fold);
  for (const language of ["en", "zh-CN"] as const) {
    await setLanguage(window, language);
    for (const every of [false, true]) {
      await newMind(window);
      await insert(window, stillNote(language, documents));
      if (every) await showEveryCheckResult(window);
      for (const scheme of ["light", "dark"] as const) {
        await window.emulateMedia({ colorScheme: scheme });
        for (const width of [1280, 900]) {
          await setWindowSize(app, window, width, 820);
          await pointAndClick(window, editorOf(window).locator(":scope > p").last());
          await motionSettled(window);
          const name = `${every ? "every-result" : "after"}-${language}-${scheme}-${width}`;
          await window.screenshot({ path: join(folder, `${name}.png`) });
          if (every) continue;
          await checkCard(window);
          await motionSettled(window);
          await window.screenshot({
            path: join(folder, `after-card-${language}-${scheme}-${width}.png`),
          });
          await window.keyboard.press("Escape");
        }
      }
      await window.keyboard.press("ControlOrMeta+w");
    }
  }
  await app.close();
});
