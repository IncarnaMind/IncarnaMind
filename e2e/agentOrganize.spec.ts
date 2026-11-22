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
  test(`${language}: the Review opens once the User's own AI has answered for every Document, and nothing is made before Confirm`, async () => {
    const data = await createDataFolder();
    const source = await createDataFolder();
    const { app, window } = await launchApp(data);
    const shots = process.env.INCARNAMIND_SCREENSHOTS;
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
          return {
            documentId: doc.id,
            version: doc.version,
            newFolder: area?.folder[language] ?? "",
          };
        });
        const harbour = AREAS[0].folder[language];
        const propose = (batch: typeof proposals) =>
          agent.callTool({ name: "propose_sorting", arguments: { proposals: batch } });

        // A part answered: the Library's line says what came, and the rows wait; the Review stays shut.
        await propose(proposals.filter((each) => each.newFolder === harbour));
        await expect(words).toHaveText(
          translate(language, "organizeReview.suggestedBy", {
            agent: "Claude Code",
            what: translate(language, "organizeReview.willMove", {
              documents: translate(language, "organizeReview.documents", { count: 4 }),
              into: translate(language, "organizeReview.into.new.one", { count: 1 }),
            }),
          }),
        );
        await expect(line).toHaveAttribute("data-state", "landed");
        await expect(window.getByTestId("organize-asked-confirm")).toBeVisible();
        const rows = await window.getByTestId("library-document").evaluateAll((each) =>
          each.map((row) => ({
            name: row.querySelector('[data-testid="library-document-name"]')?.textContent ?? "",
            mark: row.querySelector('[data-testid="library-suggested"]')?.textContent ?? null,
          })),
        );
        for (const row of rows)
          expect(row.mark).toBe(
            (AREAS[0].documents as readonly string[]).includes(row.name)
              ? translate(language, "library.row.suggested", { folder: harbour })
              : null,
          );
        await expect(window.getByTestId("organize-review")).toHaveCount(0);
        if (shots) {
          await mkdir(shots, { recursive: true });
          await motionSettled(window);
          await window.screenshot({ path: join(shots, `part-${language}-${width}.png`) });
        }

        // Every Document answered: the Review opens by itself, naming the AI once.
        await propose(proposals.filter((each) => each.newFolder !== harbour));
      } finally {
        await agent.close();
      }
      await expect(window.getByTestId("organize-review")).toBeVisible();
      await expect(window.getByTestId("organize-review-will-move")).toHaveText(
        translate(language, "organizeReview.suggestedBy", {
          agent: "Claude Code",
          what: translate(language, "organizeReview.willMove", {
            documents: translate(language, "organizeReview.documents", { count: 10 }),
            into: translate(language, "organizeReview.into.new", { count: 3 }),
          }),
        }),
      );
      await expect(window.getByTestId("organize-review-row")).toHaveCount(10);
      await expect(
        window.getByTestId("organize-review-row").filter({
          hasText: translate(language, "organizeReview.agent", { agent: "Claude Code" }),
        }),
      ).toHaveCount(0);
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
      if (shots) {
        await motionSettled(window);
        await window.screenshot({ path: join(shots, `review-${language}-${width}.png`) });
      }

      // With no model set up, the ⋯ offers only what works.
      await pointAndClick(window, window.getByTestId("organize-review-menu"));
      await expect(window.getByTestId("organize-review-discard")).toBeVisible();
      for (const replan of ["fewer", "more", "again"])
        await expect(window.getByTestId(`organize-review-${replan}`)).toHaveCount(0);
      if (shots) {
        await motionSettled(window);
        await window.screenshot({ path: join(shots, `menu-${language}-${width}.png`) });
      }
      await window.keyboard.press("Escape");

      await pointAndClick(window, window.getByTestId("organize-review-confirm"));
      await expect.poll(groups).toEqual({
        folders: AREAS.map((each) => each.folder[language]).sort(),
        filed: 10,
      });
      await expect(window.getByTestId("organize-review")).toHaveCount(0);
      await expect(window.getByTestId("organize-asked")).toHaveCount(0);
      await expect(window.getByTestId("library-suggested")).toHaveCount(0);
    } finally {
      await app.close();
      await removeDataFolder(data);
      await removeDataFolder(source);
    }
  });
}
