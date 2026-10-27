import { expect, test } from "@playwright/test";
import {
  addToNote,
  askInAssistant,
  coreOf,
  createDataFolder,
  dismissChatSetup,
  enterContent,
  exportFromMenu,
  frontMindName,
  launchApp,
  nameMind,
  newMind,
  removeDataFolder,
  setLanguage,
  setWindowSize,
  useLocalChatModel,
  useOutputLocation,
} from "./app";

const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

let dataDir: string;
let saved: string;
test.beforeEach(async () => {
  dataDir = await createDataFolder();
  saved = await createDataFolder();
});
test.afterEach(async () => {
  await removeDataFolder(dataDir);
  await removeDataFolder(saved);
});

test("a Mind's page has no title field: its first line names it, live, until a name is typed in Rename, and clearing that name goes back to the first line", async () => {
  const { app, window } = await launchApp(dataDir);
  await setWindowSize(app, window, 1280, 660);
  await dismissChatSetup(window);

  await window.getByTestId("plus-menu").click();
  await window.getByTestId("plus-new-mind").click();
  // The cursor is on the new Mind's first line, with nothing above it.
  await enterContent(window);
  await expect(window.getByTestId("mind-title")).toHaveCount(0);
  const row = window.getByTestId("mind-list-item");
  const tab = window.getByTestId("mind-tab");
  await expect(row).toContainText("Untitled");
  await expect(tab).toContainText("Untitled");

  await window.keyboard.type("Tides in Bergen");
  await expect(row).toContainText("Tides in Bergen");
  await expect(tab).toContainText("Tides in Bergen");
  await window.keyboard.type(" and the moon");
  await expect(row).toContainText("Tides in Bergen and the moon");
  await expect(tab).toContainText("Tides in Bergen and the moon");

  // Rename in the sidebar names it, and leaves its text as it is.
  const mindRow = window.getByTestId("mind-row");
  const rename = async () => {
    await mindRow.hover();
    await mindRow.getByTestId("mind-menu").click();
    await mindRow.getByTestId("mind.rename").click();
    const field = window.getByTestId("mind-rename");
    await expect(field).toBeFocused();
    return field;
  };
  const field = await rename();
  await expect(field).toHaveAttribute("placeholder", "Tides in Bergen and the moon");
  await field.fill("My own title");
  await field.press("Enter");
  await expect(row).toContainText("My own title");
  await expect(row).not.toContainText("Tides");
  await expect(tab).toContainText("My own title");
  await expect(window.getByTestId("mind-editor")).toHaveText("Tides in Bergen and the moon");

  // Cleared, the first line names it again.
  await (await rename()).fill("");
  await window.keyboard.press("Enter");
  await expect(row).toContainText("Tides in Bergen and the moon");
  await expect(tab).toContainText("Tides in Bergen and the moon");
  await app.close();
});

test("a long first line is cut at a word, and a Chinese one at a character", async () => {
  const { app, window } = await launchApp(dataDir);
  await setWindowSize(app, window, 1280, 660);
  await dismissChatSetup(window);

  await window.getByTestId("plus-menu").click();
  await window.getByTestId("plus-new-mind").click();
  await enterContent(window);
  await window.keyboard.type(
    "How much cooler are large irrigated parks than the surrounding built-up streets during clear windless summer nights",
  );
  const row = window.getByTestId("mind-list-item");
  await expect(row).toContainText("irrigated parks");
  await expect(row).not.toContainText("than");

  await window.getByTestId("plus-menu").click();
  await window.getByTestId("plus-new-mind").click();
  await enterContent(window);
  await window.keyboard.type("夜间降温".repeat(20));
  await expect(window.getByTestId("mind-list-item").first()).toContainText("夜间降温".repeat(15));
  await expect(window.getByTestId("mind-list-item").first()).not.toContainText(
    "夜间降温".repeat(16),
  );
});

const FROM_QUESTION = [
  {
    language: "en",
    width: 1440,
    question:
      "How many days of paid holiday does a full-time employee get in a year, and how much notice after probation?",
    name: "This is a scripted Answer to: How many days of paid holiday",
  },
  {
    language: "en",
    width: 1100,
    question:
      "How many days of paid holiday does a full-time employee get in a year, and how much notice after probation?",
    name: "This is a scripted Answer to: How many days of paid holiday",
  },
  {
    language: "zh-CN",
    width: 1440,
    question:
      "员工每年享有多少天带薪年假，试用期结束后需要提前多久通知公司解除劳动合同，以及需要支付哪些补偿，还有哪些情形下公司可以不提前通知直接解除合同？",
    name: "This is a scripted Answer to: 员工每年享有多少天带薪年假",
  },
  {
    language: "zh-CN",
    width: 1100,
    question:
      "员工每年享有多少天带薪年假，试用期结束后需要提前多久通知公司解除劳动合同，以及需要支付哪些补偿，还有哪些情形下公司可以不提前通知直接解除合同？",
    name: "This is a scripted Answer to: 员工每年享有多少天带薪年假",
  },
] as const;

for (const { language, width, question, name } of FROM_QUESTION) {
  test(`Add to note into an empty Mind names it by the Note's first line, never the Question; the tab shows it on one line with the whole name in its tooltip, and the exported file takes the Question (${language}, ${width}px)`, async () => {
    const { app, window } = await launchApp(dataDir, { fakeChat: true });
    await dismissChatSetup(window);
    await useLocalChatModel(window);
    await useOutputLocation(window, saved);
    await setLanguage(window, language);
    await setWindowSize(app, window, width, 700);
    await newMind(window);
    const tabName = frontMindName(window);
    await expect(tabName).toHaveText(language === "en" ? "Untitled" : "未命名");

    const answer = await askInAssistant(window, question);
    await addToNote(window, answer);
    const editor = window.getByTestId("mind-editor");
    const answerText = (await editor.locator(":scope > p").first().innerText()).trim();
    expect(answerText).not.toBe("");

    // The Mind's name is the first line of what went in, cut cleanly, not the Question (#1174), and not typed.
    // The line cuts it in the middle, its tooltip has the whole name.
    const added = answer.getByTestId("answer-added");
    const status = added.locator('[role="status"]');
    const characters = [...name];
    await expect(added).toContainText(characters.slice(0, 4).join(""));
    await expect(added).toContainText(characters.slice(-4).join(""));
    await expect(added).not.toContainText(name);
    await expect(status).toHaveAttribute("title", new RegExp(escaped(name)));
    // However long the name, the line keeps its words and its Undo on one row.
    const [words, undo] = await Promise.all([
      status.boundingBox(),
      added.getByTestId("answer-added-undo").boundingBox(),
    ]);
    expect(Math.abs((undo?.y ?? 0) - (words?.y ?? 100))).toBeLessThan(8);
    const row = window.getByTestId("mind-list-item");
    await expect(row).toContainText(name);
    // Not typed: Rename's field would be empty.
    const typed = await (await coreOf(window)).evaluate(
      async (core) => (await core.listMinds())[0]?.title,
    );
    expect(typed).toBe("");

    // The tab shows the name on one line, and the whole name in its tooltip.
    await expect(tabName).toHaveText(name);
    await expect(window.locator('[data-testid="mind-tab"][aria-selected="true"]')).toHaveAttribute(
      "title",
      name,
    );
    const oneLine = await tabName.evaluate((element) => {
      const lineHeight = Number.parseFloat(getComputedStyle(element).lineHeight);
      return element.getBoundingClientRect().height <= lineHeight * 1.5;
    });
    expect(oneLine).toBe(true);

    // The file takes the Question that made the note, whole (#1945).
    await exportFromMenu(window);
    const done = window.getByTestId("export-result").getByTestId("export-done");
    await expect(done).toContainText(".docx", { timeout: 30_000 });
    expect(await done.getAttribute("title")).toContain(`${question.replace(/[?？.]$/, "")}.docx`);
    await app.close();
  });
}

test("a name the User typed is never replaced when an Answer is added to the Mind", async () => {
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await setWindowSize(app, window, 1280, 700);
  await dismissChatSetup(window);
  await useLocalChatModel(window);
  await newMind(window);
  await nameMind(window, "My own title");

  const answer = await askInAssistant(window, "How many days of paid holiday?");
  await addToNote(window, answer);

  await expect(frontMindName(window)).toHaveText("My own title");
  await expect(window.getByTestId("mind-list-item")).toContainText("My own title");
  await expect(window.getByTestId("mind-list-item")).not.toContainText("How many days");
  await app.close();
});
