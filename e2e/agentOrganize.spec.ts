import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import type { SortingBatch } from "../src/core/agents/sorting";
import { ALL_SHARED_ID, type CoreBridge } from "../src/core/api";
import { translate } from "../src/shared/i18n";
import { legacyAgentClient } from "../tests/helpers/agentClients";
import {
  acceptPlainTextKeys,
  createDataFolder,
  dismissChatSetup,
  expectReadyDocuments,
  launchApp,
  motionSettled,
  pointAndClick,
  removeDataFolder,
  runCommand,
  setLanguage,
  setWindowSize,
  urlsOpened,
} from "./app";

/** Ten Documents of three areas of work, and the Folder each would go into, in each language. */
const AREAS = [
  {
    folder: { en: "Harbour works", "zh-CN": "港口工程" },
    documents: ["Quay repair", "Dredging plan", "Pier survey", "Crane contract"],
  },
  {
    folder: { en: "Family health", "zh-CN": "家人健康" },
    documents: ["Vaccination record", "Dentist letter", "Allergy plan"],
  },
  {
    folder: { en: "Tax return", "zh-CN": "报税" },
    documents: ["Tax receipts", "Pension statement", "Charity donations"],
  },
] as const;

for (const [language, width] of [
  ["en", 1440],
  ["zh-CN", 900],
] as const) {
  test(`${language}: the Library says what the User's own AI suggests, and nothing is made before Confirm`, async () => {
    const data = await createDataFolder();
    const source = await createDataFolder();
    const { app, window } = await launchApp(data);
    try {
      await dismissChatSetup(window);
      await acceptPlainTextKeys(window);
      await setWindowSize(app, window, width, 820);
      await setLanguage(window, language);
      const paths: string[] = [];
      for (const area of AREAS)
        for (const name of area.documents) {
          const path = join(source, `${name}.md`);
          await writeFile(path, `# ${name}\n\n${name}, filed under ${area.folder.en}.`);
          paths.push(path);
        }
      const launch = await window.evaluate(
        async ({ paths, all }) => {
          const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
          await bridge.addDocuments(paths);
          await bridge.setAgentsEnabled(true);
          return (
            await bridge.connectAgent({
              name: "Claude Code",
              client: "claude-code",
              folderIds: [all],
            })
          ).launch;
        },
        { paths, all: ALL_SHARED_ID },
      );
      await expectReadyDocuments(window, paths.length);
      await runCommand(window, "library.open", translate(language, "library.open"));
      const organize = window.getByTestId("library-sort-into-folders");
      await expect(organize).toHaveText(
        translate(language, "library.organize.withAgent", { agent: "Claude Code" }),
      );
      await pointAndClick(window, organize);
      await expect.poll(() => urlsOpened(app)).toHaveLength(1);
      const line = window.getByTestId("organize-asked");
      const words = line.locator(".meta-part").first();
      await expect(words).toHaveText(
        translate(language, "agents.asked.opened", { agent: "Claude Code" }),
      );

      const agent = await legacyAgentClient(launch);
      try {
        const listed: SortingBatch["documents"] = [];
        let after: string | null = "";
        while (after !== null) {
          const page = (
            await agent.callTool({ name: "list_sorting", arguments: after ? { after } : {} })
          ).structuredContent as unknown as SortingBatch;
          listed.push(...page.documents);
          after = page.next;
        }
        await expect(words).toHaveText(
          translate(language, "agents.asked.organizing", { agent: "Claude Code" }),
        );
        const proposals = listed.map((doc) => {
          const area = AREAS.find((each) =>
            (each.documents as readonly string[]).includes(doc.name),
          );
          return { documentId: doc.id, version: doc.version, newFolder: area?.folder[language] };
        });
        for (const batch of [proposals.slice(0, 8), proposals.slice(8)])
          await agent.callTool({ name: "propose_sorting", arguments: { proposals: batch } });
      } finally {
        await agent.close();
      }

      const what = translate(language, "organizeReview.willMove", {
        documents: translate(language, "organizeReview.documents", { count: 10 }),
        into: translate(language, "organizeReview.into.new", { count: 3 }),
      });
      await expect(words).toHaveText(
        translate(language, "organizeReview.suggestedBy", { agent: "Claude Code", what }),
      );
      await expect(line).toHaveAttribute("data-state", "landed");
      // Each row shown says it waits: the section shows its first rows, then Show all.
      const marks = window.getByTestId("library-suggested");
      await expect(marks).toHaveCount(await window.getByTestId("library-document").count());
      const first = window.getByTestId("library-document").first();
      const name = await first.getByTestId("library-document-name").textContent();
      const area = AREAS.find((each) => (each.documents as readonly string[]).includes(name ?? ""));
      await expect(first.getByTestId("library-suggested")).toHaveText(
        translate(language, "library.row.suggested", { folder: area?.folder[language] ?? "" }),
      );
      const groups = () =>
        window.evaluate(async () => {
          const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
          const { groups, assignments } = await bridge.getLibrary();
          return {
            folders: groups.map((each) => each.name).sort(),
            filed: assignments.filter((each) => each.groupId !== null).length,
          };
        });
      expect(await groups()).toEqual({ folders: [], filed: 0 });

      const shots = process.env.INCARNAMIND_SCREENSHOTS;
      if (shots) {
        await mkdir(shots, { recursive: true });
        await motionSettled(window);
        await window.screenshot({ path: join(shots, `suggested-${language}-${width}.png`) });
        // The same page without the rows' marks, for the owner to choose between (#3610).
        const hidden = await window.addStyleTag({
          content: '[data-testid="library-suggested"] { display: none !important; }',
        });
        await window.screenshot({ path: join(shots, `unmarked-${language}-${width}.png`) });
        await hidden.evaluate((style) => style.parentNode?.removeChild(style));
      }

      await pointAndClick(window, window.getByTestId("organize-asked-confirm"));
      await expect.poll(groups).toEqual({
        folders: AREAS.map((each) => each.folder[language]).sort(),
        filed: 10,
      });
      await expect(window.getByTestId("organize-asked")).toHaveCount(0);
      await expect(marks).toHaveCount(0);
    } finally {
      await app.close();
      await removeDataFolder(data);
      await removeDataFolder(source);
    }
  });
}
