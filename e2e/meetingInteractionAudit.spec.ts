import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { closeSettings, coreOf, createDataFolder, dismissChatSetup, firstTranscriptLine, launchApp, openSettings, pointAndClick, recordMeeting, removeDataFolder, setLanguage, setWindowSize, transcribeHere, transcriptSaved } from "./app";

for (const example of [
  { language: "en", width: 1280, height: 800, zoom: 1, dark: false },
  { language: "zh-CN", width: 900, height: 660, zoom: 1, dark: false },
  { language: "zh-CN", width: 900, height: 660, zoom: 1.25, dark: true },
] as const) {
  test(`exercise meeting controls at ${example.width} in ${example.language} at zoom ${example.zoom}`, async () => {
    test.setTimeout(180000);
    const folder = process.env.INCARNAMIND_SCREENSHOTS;
    if (!folder) throw new Error("Need a folder for this visual check.");
    const axe = await readFile(join(process.env.RUNNER_TEMP!, "meeting-qa-axe/package/axe.min.js"), "utf8");
    const data = await createDataFolder();
    const { app, window } = await launchApp(data, { computerSound: "silent", transcriber: { live: true, lines: ["Please check the budget.", "I will do that on Friday."] } });
    const prefix = `walk-${example.language}-${example.width}-${example.zoom}`;
    const sample = async (stage: string, page: Page = window) => {
      await page.evaluate(axe);
      const evidence = await page.evaluate(async () => {
        const scan = await (window as unknown as {axe:{run:Function}}).axe.run(document, {runOnly:{type:"tag",values:["wcag2a","wcag2aa","wcag21a","wcag21aa"]},resultTypes:["violations"]});
        return {actualWindow:[innerWidth,innerHeight], scrollWidth:document.documentElement.scrollWidth, theme:document.documentElement.dataset.theme,
          findings:scan.violations.map((v:{id:string;impact:string;nodes:{target:string[];failureSummary:string;html:string}[]})=>({rule:v.id,impact:v.impact,nodes:v.nodes.map(n=>({target:n.target,detail:n.failureSummary,html:n.html.slice(0,220)}))}))};
      });
      await page.screenshot({ path:join(folder, prefix+"-"+stage+".png"), animations:"disabled" });
      await writeFile(join(folder,prefix+"-"+stage+".json"),JSON.stringify(evidence,null,2));
    };
    try {
      await dismissChatSetup(window);
      await setWindowSize(app,window,example.width,example.height);
      if(example.dark) await app.evaluate(({nativeTheme})=>{nativeTheme.themeSource="dark";});
      if(example.zoom!==1) await app.evaluate(({BrowserWindow},factor)=>{BrowserWindow.getAllWindows()[0]?.webContents.setZoomFactor(factor);},example.zoom);
      const settings = await openSettings(window,"meetings");
      await expect(settings).toBeVisible();
      await closeSettings(window);
      await setLanguage(window,example.language);
      const start = await recordMeeting(window);
      await sample("start");
      await pointAndClick(window,start.getByTestId("meeting-start-record"));
      const notice = window.getByTestId("meeting-notice");
      await expect(notice).toBeVisible();
      await sample("notice");
      const focus=[];
      for(let i=0;i<9;i++) {
        await window.keyboard.press("Tab");
        focus.push(await window.evaluate(()=>{const el=document.activeElement;return {inDialog:!!el?.closest('[role="dialog"], dialog'),control:el?.getAttribute("data-testid")||el?.getAttribute("aria-label")||el?.textContent?.slice(0,60),visibleFocus:el?.matches(":focus-visible")};}));
      }
      await writeFile(join(folder,prefix+"-keyboard.json"),JSON.stringify(focus));
      await transcribeHere(notice);
      await pointAndClick(window,notice.getByTestId("meeting-notice-start"));
      const bar=window.getByTestId("meeting-bar");
      await expect(bar).toHaveAttribute("data-status","recording");
      await firstTranscriptLine(window);
      await sample("live");
      await pointAndClick(window,bar.getByTestId("meeting-pause"));
      await expect(bar).toHaveAttribute("data-status","paused");
      await sample("paused");
      await pointAndClick(window,bar.getByTestId("meeting-resume"));
      await expect(bar).toHaveAttribute("data-status","recording");
      await pointAndClick(window,bar.getByTestId("meeting-views").locator("label").nth(1));
      const transcript=window.getByTestId("meeting-note-transcript");
      await expect(transcript).toBeVisible();
      await sample("transcript");
      await pointAndClick(window,transcript.getByTestId("meeting-stop"));
      await transcriptSaved(window);
      await sample("stopped");
    } finally {
      await app.close();
      await removeDataFolder(data);
    }
  });
}
