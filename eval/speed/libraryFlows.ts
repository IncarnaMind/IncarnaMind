/**
 * The Library's AI flows `npm run eval:speed` times (#1624): Folders proposed for Documents that
 * have none (the Library's grouping), Organize filing Documents into Folders, and automatic Tags
 * worked out again. Each runs on the model Automatic picks for tagging and Organize with the
 * User's Answers model saved, as the Library's "Use …" saves it, and is timed from the press to
 * the last Document done, by the signs the Library shows. Each run leaves the Library's Folders as
 * it found them, so the flows after it search and sort as before.
 */
import type { Core, CoreEventName, LibraryGroup } from "../../src/core";
import {
  type Flow,
  type FlowContext,
  type FlowSigns,
  type Language,
  timed,
  wordsAtEnd,
} from "./signs";

/** The sample Documents sorted: two reports, a code of practice and two papers. */
const SORTED = [
  "Vantrell",
  "Norvath",
  "MPMA Code",
  "Tuning the Tuner",
  "What a Corpus Teaches",
] as const;

const FOLDERS: Record<Language, readonly string[]> = {
  en: ["Annual and ESG reports", "Industry codes of practice", "Machine learning papers"],
  "zh-CN": ["年度报告与 ESG 报告", "行业行为准则", "机器学习论文"],
};

/** The longest one run waits for its Documents to be done. */
const LIMIT_MS = 5 * 60_000;
const POLL_MS = 100;

function sortedIds({ documents }: FlowContext): string[] {
  const ids = SORTED.flatMap(
    (part) => [...documents.values()].find((document) => document.name.includes(part))?.id ?? [],
  );
  if (ids.length !== SORTED.length) throw new Error("The sample Documents aren't all here.");
  return ids;
}

/**
 * Organize and tagging on the model Automatic picks, allowed to send to its service: what the
 * Library's "Use …" saves. Sorting stays a press: new Documents aren't sent by themselves.
 */
async function readyToSort(core: Core): Promise<void> {
  const automatic = (await core.getTaggingModels()).automatic;
  if (!automatic) throw new Error("No model can tag or organize with this provider.");
  const { settings } = await core.getLibrary();
  await core.saveLibrarySettings({
    ...settings,
    classifier: automatic.classifier,
    organizeWith: automatic.classifier,
    automatic: false,
  });
  for (const flow of ["tagging", "classification"] as const) {
    const route = await core.getTaggingRoute(flow);
    if (route.where === "cloud") await core.allowDataFlow(flow, route.service.id);
  }
}

async function until(done: () => Promise<boolean>, what: string): Promise<void> {
  const start = performance.now();
  while (!(await done())) {
    if (performance.now() - start > LIMIT_MS) throw new Error(`${what} took too long.`);
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

/** Times `act` by the Library's own signs, any Note's included. */
async function timedInLibrary(
  context: FlowContext,
  act: () => Promise<unknown>,
  signs: readonly CoreEventName[],
): Promise<FlowSigns> {
  return wordsAtEnd(await timed(context.core, null, act, signs));
}

async function withoutFolders(core: Core, groups: readonly LibraryGroup[]): Promise<void> {
  for (const group of groups) await core.deleteLibraryGroup(group.id);
}

const ORGANIZED = new Set(["classified", "failed"]);
const TAGGED = new Set(["tagged", "no-tags", "failed", "skipped"]);

export const LIBRARY_FLOWS: readonly Flow[] = [
  {
    id: "library-grouping",
    label: "Organize with no Folders yet: Folders proposed for five Documents",
    async run(context) {
      const { core } = context;
      await readyToSort(core);
      const ids = sortedIds(context);
      let made: LibraryGroup[] = [];
      try {
        return await timedInLibrary(context, async () => {
          made = await core.proposeFolders(ids);
          if (made.length === 0) throw new Error("No Folder was proposed.");
        }, ["library.changed"]);
      } finally {
        await withoutFolders(core, made);
      }
    },
  },
  {
    id: "organize",
    label: "Organize: five Documents filed into three Folders, with their Tags",
    async run(context) {
      const { core, language } = context;
      await readyToSort(core);
      const ids = sortedIds(context);
      const folders: LibraryGroup[] = [];
      try {
        for (const name of FOLDERS[language]) {
          folders.push(await core.createLibraryGroup({ name, description: "" }));
        }
        return await timedInLibrary(context, async () => {
          await core.classifyDocuments(ids);
          await until(async () => {
            const { assignments } = await core.getLibrary();
            return ids.every((id) =>
              assignments.some((each) => each.documentId === id && ORGANIZED.has(each.status)),
            );
          }, "Organize");
        }, ["library.assignments", "documents.tagged"]);
      } finally {
        await withoutFolders(core, folders);
      }
    },
  },
  {
    id: "tags",
    label: "Automatic Tags worked out again for five Documents",
    async run(context) {
      const { core } = context;
      await readyToSort(core);
      const ids = sortedIds(context);
      return timedInLibrary(context, async () => {
        await core.retagDocuments(ids);
        await until(async () => {
          const listed = await core.listDocuments();
          return ids.every((id) =>
            listed.some((each) => each.id === id && TAGGED.has(each.tagging)),
          );
        }, "Tagging");
      }, ["documents.tagged"]);
    },
  },
];
