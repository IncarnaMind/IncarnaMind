/**
 * The Library's AI flows `npm run eval:speed` times (#1624): Folders proposed for Documents that
 * have none (the Library's grouping), Organize filing Documents into Folders, and automatic Tags
 * worked out again. Each runs on the model Automatic picks for tagging and Organize with the
 * User's Answers model saved, as the Library's "Use …" saves it, and is timed from the press to
 * the last Document done, by the signs the Library shows. Each run leaves the Library's Folders
 * and settings as it found them, so the flows after it search and sort as before; the Tags it
 * gave the sample Documents stay.
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
 * Organize on the model Automatic picks, allowed to send to its service, as the Library's "Use …"
 * saves it; `work` runs with it, and the Library's settings are put back after.
 */
async function sorting<T>(core: Core, work: () => Promise<T>): Promise<T> {
  const automatic = (await core.getTaggingModels()).automatic;
  if (!automatic) throw new Error("No model can tag or organize with this provider.");
  const { settings } = await core.getLibrary();
  await core.saveLibrarySettings({ ...settings, organizeWith: automatic.classifier });
  for (const flow of ["tagging", "classification"] as const) {
    const route = await core.getTaggingRoute(flow);
    if (route.where === "cloud") await core.allowDataFlow(flow, route.service.id);
  }
  try {
    return await work();
  } finally {
    await core.saveLibrarySettings(settings);
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

/** Throws for Documents that ended failed: a run that sent nothing for them isn't timed as done. */
function noneFailed(states: readonly string[], what: string): void {
  const failed = states.filter((state) => state === "failed").length;
  if (failed > 0) throw new Error(`${what} failed for ${failed} Documents.`);
}

export const LIBRARY_FLOWS: readonly Flow[] = [
  {
    id: "library-grouping",
    label: "Organize with no Folders yet: Folders proposed for five Documents",
    async run(context) {
      const { core } = context;
      const ids = sortedIds(context);
      let made: LibraryGroup[] = [];
      return sorting(core, async () => {
        try {
          return await timedInLibrary(context, async () => {
            made = await core.proposeFolders(ids);
            if (made.length === 0) throw new Error("No Folder was proposed.");
          }, ["library.changed"]);
        } finally {
          await withoutFolders(core, made);
        }
      });
    },
  },
  {
    id: "organize",
    label: "Organize: five Documents filed into three Folders, with their Tags",
    async run(context) {
      const { core, language } = context;
      const ids = sortedIds(context);
      const folders: LibraryGroup[] = [];
      const statuses = async () =>
        (await core.getLibrary()).assignments.filter((each) => ids.includes(each.documentId));
      return sorting(core, async () => {
        try {
          for (const name of FOLDERS[language]) {
            folders.push(await core.createLibraryGroup({ name, description: "" }));
          }
          const signs = await timedInLibrary(context, async () => {
            await core.classifyDocuments(ids);
            await until(async () => {
              const done = (await statuses()).filter((each) => ORGANIZED.has(each.status));
              return done.length === ids.length;
            }, "Organize");
          }, ["library.assignments", "documents.tagged"]);
          noneFailed(
            (await statuses()).map((each) => each.status),
            "Organize",
          );
          return signs;
        } finally {
          await withoutFolders(core, folders);
        }
      });
    },
  },
  {
    id: "tags",
    label: "Automatic Tags worked out again for five Documents",
    async run(context) {
      const { core } = context;
      const ids = sortedIds(context);
      const states = async () =>
        (await core.listDocuments()).filter((each) => ids.includes(each.id));
      return sorting(core, async () => {
        const signs = await timedInLibrary(context, async () => {
          await core.retagDocuments(ids);
          await until(async () => {
            const done = (await states()).filter((each) => TAGGED.has(each.tagging));
            return done.length === ids.length;
          }, "Tagging");
        }, ["documents.tagged"]);
        noneFailed(
          (await states()).map((each) => each.tagging),
          "Tagging",
        );
        return signs;
      });
    },
  },
];

export const LIBRARY_FLOW_IDS: ReadonlySet<string> = new Set(LIBRARY_FLOWS.map((flow) => flow.id));
