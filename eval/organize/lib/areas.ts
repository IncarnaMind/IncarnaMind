/**
 * The areas a plan is read by (#2737): the five starter Folders', in the words the app shows for
 * them, and personal. A Document's areas are written by a person (`AREAS_FILE`), never fitted to a
 * run: one area, a second only where one file is two things, or none when nobody could place it.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Language } from "../../../src/core/language";
import { translate } from "../../../src/shared/i18n/index";
import { libraryPresetKeys } from "../../../src/shared/libraryPresets";

export const AREAS = [...libraryPresetKeys, "personal"] as const;
export type Area = (typeof AREAS)[number];

const PERSONAL: Record<Language, string> = {
  en: "A person's own papers outside work: a diary, recipes, to-do notes, notes on books they read, manuals for things at home.",
  "zh-CN": "工作以外的个人文件：日记、菜谱、待办便条、读书笔记、家里物品的说明书。",
};

/** What an area holds, as a reader is told it. */
export function areaWords(area: Area, language: Language): string {
  return area === "personal"
    ? PERSONAL[language]
    : translate(language, `library.preset.${area}.description`);
}

/** One value an area, every area named. */
export const byArea = <T>(make: (area: Area) => T): Record<Area, T> => ({
  research: make("research"),
  reports: make("reports"),
  contracts: make("contracts"),
  finance: make("finance"),
  meetings: make("meetings"),
  personal: make("personal"),
});

export function isArea(value: unknown): value is Area {
  return AREAS.some((area) => area === value);
}

export interface DocumentAreas {
  area: Area | null;
  second?: Area;
}

export const AREAS_FILE = "tests/fixtures/organize/areas.json";

/** A Document's areas as a list: none, one, or two. */
export function areasOf(entry: DocumentAreas): Area[] {
  return [entry.area, entry.second].filter((area): area is Area => area != null);
}

/** The areas file's `areas`, checked: a known area or null, and a second only beside a first. */
export function parseAreas(value: unknown): Map<string, DocumentAreas> {
  const areas =
    typeof value === "object" && value !== null ? (value as { areas?: unknown }).areas : null;
  if (typeof areas !== "object" || areas === null)
    throw new Error('An areas file holds {"note", "areas": {"<document id>": {"area"}}}.');
  const out = new Map<string, DocumentAreas>();
  for (const [id, entry] of Object.entries(areas)) {
    const raw = (entry ?? {}) as { area?: unknown; second?: unknown };
    const area = raw.area === null ? null : isArea(raw.area) ? raw.area : undefined;
    if (area === undefined) throw new Error(`${id}: "${String(raw.area)}" is no area.`);
    if (raw.second === undefined) {
      out.set(id, { area });
      continue;
    }
    if (!isArea(raw.second) || area === null || raw.second === area)
      throw new Error(`${id}: a second area is another known area, beside a first one.`);
    out.set(id, { area, second: raw.second });
  }
  return out;
}

export async function readAreas(root: string, file = join(root, AREAS_FILE)) {
  return parseAreas(JSON.parse(await readFile(file, "utf8")));
}
