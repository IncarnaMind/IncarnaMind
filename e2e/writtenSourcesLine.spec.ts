import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import {
  addDocuments,
  askInAssistant,
  assistantAnswers,
  createDataFolder,
  dismissChatSetup,
  firstTranscriptLine,
  launchApp,
  newMind,
  openSteps,
  pointAndClick,
  recordMeeting,
  removeDataFolder,
  setLanguage,
  setWindowSize,
  startRecording,
  useLocalChatModel,
} from "./app";

/**
 * The line above an Answer that wrote cited text into the Note (#2768) names the sources that text
 * cites, and its search counts them used: during a meeting, and when the write was stopped
 * halfway. The request names its two Documents, so no third that "report" fits is named as read.
 */

const SCREENSHOTS = process.env.INCARNAMIND_SCREENSHOTS;
const shot = async (window: Page, name: string) => {
  if (SCREENSHOTS) await window.screenshot({ path: join(SCREENSHOTS, `${name}.png`) });
};

let dataDir: string;
let files: string;
test.beforeEach(async () => {
  dataDir = await createDataFolder();
  files = await mkdtemp(join(tmpdir(), "written-sources-e2e-"));
});
test.afterEach(async () => {
  await removeDataFolder(dataDir);
  await rm(files, { recursive: true, force: true });
});

/** The two Documents asked about, a third that "report" fits, and more: past the twelve sent whole. */
const LIBRARY = {
  en: [
    ["Field Report", "The spring survey read twelve tide gauges along the northern estuary."],
    [
      "Quarterly Research Update",
      "The tide model now covers the harbour mouth and the upper reach.",
    ],
    ["Harlow Basin Annual Report 2022", "The basin authority approved the field survey."],
    ["Ferry Timetable Report", "Ferries leave the north pier every forty minutes."],
    ["Parking rota", "Spaces in the basement are given out monthly."],
    ["Travel claims", "Staff fill in a form before they travel."],
    ["Purchasing steps", "A head of department approves each purchase."],
    ["Appraisal guide", "Appraisals happen twice a year in four bands."],
    ["Client list", "Eastern clients: Hollin, Marrow and Sedge."],
    ["Office supplies", "Paper, pens, folders and staplers."],
    ["Staff handbook contents", "Attendance, leave, learning and leaving."],
    ["Induction plan", "New starters spend two days in induction."],
    ["Visitor log", "Visitors sign in at the front desk."],
  ],
  "zh-CN": [
    ["现场报告", "春季调查读取了北部河口的十二个潮位站。"],
    ["季度研究更新", "潮汐模型现在覆盖港口入口和上游河段。"],
    ["哈洛盆地2022年度报告", "盆地管理局批准了这次现场调查。"],
    ["渡轮时刻报告", "渡轮每四十分钟从北码头出发。"],
    ["停车位安排", "地下车位按月分配。"],
    ["差旅报销制度", "员工出差前需填写申请单。"],
    ["采购流程", "采购申请由部门负责人审批。"],
    ["绩效考核说明", "考核每半年一次，结果分为四档。"],
    ["客户名单", "华东区客户：恒远、启明、南岭。"],
    ["办公用品清单", "打印纸、签字笔、文件夹与订书机。"],
    ["员工手册目录", "考勤、假期、培训与离职四章。"],
    ["培训计划", "新员工入职培训为期两天。"],
    ["访客登记", "访客需在前台登记并领取临时证件。"],
  ],
} as const;

async function library(language: keyof typeof LIBRARY): Promise<string[]> {
  return Promise.all(
    LIBRARY[language].map(async ([name, text]) => {
      const path = join(files, `${name}.md`);
      await writeFile(path, `# ${name}\n\n${text}\n`);
      return path;
    }),
  );
}

test("a cited write during a meeting names its sources; in Chinese", async () => {
  test.setTimeout(120_000);
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await setWindowSize(app, window, 1440, 900);
  await dismissChatSetup(window);
  await useLocalChatModel(window);
  await setLanguage(window, "zh-CN");
  await addDocuments(window, await library("zh-CN"));
  await startRecording(window, await recordMeeting(window), { notice: true });
  await firstTranscriptLine(window);
  await window.getByTestId("mind-editor").click();

  const answer = await askInAssistant(
    window,
    "在这个笔记里为现场报告和季度研究更新各写一节详细摘要。",
  );
  await expect(window.getByTestId("mind-editor").getByTestId("citation-chip")).toHaveCount(2);
  const steps = answer.getByTestId("answer-steps");
  await shot(window, "meeting-write-line-zh");

  await expect(steps).toHaveText("已听实时转写 · 2 个来源");
  await expect(answer.getByTestId("answer-coverage")).toHaveCount(0);
  const timeline = await openSteps(window, answer);
  await shot(window, "meeting-write-steps-zh");
  await expect(timeline.getByTestId("answer-step-found")).toHaveText(/，用了 2 段$/);
  await expect(timeline.getByTestId("answer-step-source")).toHaveCount(2);
});

test("a write stopped halfway names the source of what it wrote", async () => {
  test.setTimeout(120_000);
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await setWindowSize(app, window, 1440, 900);
  await dismissChatSetup(window);
  await useLocalChatModel(window);
  await setLanguage(window, "en");
  await addDocuments(window, await library("en"));
  await newMind(window);
  await window.keyboard.type("Estuary");

  await window.keyboard.press("ControlOrMeta+j");
  await expect(window.getByTestId("composer-input")).toBeFocused();
  await window.keyboard.type(
    "Write a detailed summary of the Field Report and the Quarterly Research Update into this note, with a section for each, and pause halfway.",
  );
  await window.keyboard.press("Enter");
  const answer = assistantAnswers(window).last();
  // The scripted model holds once the first section is in the Note, until it is stopped.
  await expect(window.getByTestId("mind-editor").getByTestId("citation-chip")).toHaveCount(1, {
    timeout: 45_000,
  });
  await expect(answer).toHaveAttribute("data-status", "streaming");
  await pointAndClick(window, window.getByTestId("composer-stop"));
  await expect(answer).toHaveAttribute("data-status", "stopped");
  await expect(window.getByTestId("mind-editor").getByTestId("citation-chip")).toHaveCount(1);
  const steps = answer.getByTestId("answer-steps");
  await shot(window, "stopped-write-line-en");

  await expect(steps).toHaveText("Searched All Documents · 1 source");
  await expect(answer.getByTestId("answer-coverage")).toHaveCount(0);
  const timeline = await openSteps(window, answer);
  await shot(window, "stopped-write-steps-en");
  await expect(timeline.getByTestId("answer-step-found")).toHaveText(/, 1 used$/);
  await expect(timeline.getByTestId("answer-mind-call")).toHaveText(
    /^Edited “Estuary” · \d changes?/,
  );
});
