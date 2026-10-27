import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { en } from "../../src/shared/i18n/en";

/*
 * Settings in few words (DESIGN.md, Words on screen): no line a Settings page
 * shows is longer than ten words, except a consent fact or an error. What a
 * page has to say beyond that is a tooltip (a key ending ".tip") or behind
 * Details (".details"), which this doesn't count.
 */

const COMPONENTS = join(__dirname, "../../src/renderer/src/components");

/** What makes up the Settings pages: each page's files, and the folders of the Agents, Connectors and Models pages. */
const FILES = [
  "SettingsDialog.tsx",
  "AiUseSettings.tsx",
  "ApprovalsSettings.tsx",
  "AuthorNameSettings.tsx",
  "EvidenceSettings.tsx",
  "MeetingsSettings.tsx",
  "MotionSettings.tsx",
  "OutputLocationSettings.tsx",
  "PrivacySettings.tsx",
  "SavedWebPagesSettings.tsx",
  "SkillsSettings.tsx",
  "SpendingCapSettings.tsx",
  "SuggestionSettings.tsx",
  "TaggingSettings.tsx",
  "WebSearchSettings.tsx",
];
const FOLDERS = ["agents", "connectors", "providers"];
/** First-run screens in those folders: not Settings. */
const NOT_SETTINGS = new Set(["ModelSetupCard.tsx", "GetOllama.tsx", "OllamaCard.tsx"]);

function sources(): { name: string; text: string }[] {
  const files = FILES.map((name) => join(COMPONENTS, name));
  for (const folder of FOLDERS) {
    for (const name of readdirSync(join(COMPONENTS, folder))) {
      if (/\.tsx$/.test(name) && !NOT_SETTINGS.has(name))
        files.push(join(COMPONENTS, folder, name));
    }
  }
  return files
    .filter((path) => existsSync(path) && statSync(path).isFile())
    .map((path) => ({ name: path.slice(COMPONENTS.length + 1), text: readFileSync(path, "utf8") }));
}

/** The messages a file names with a string literal that is one of the English strings' keys. */
function keysIn(text: string): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(/["'`]([a-zA-Z0-9_.-]+\.[a-zA-Z0-9_.-]+)["'`]/g)) {
    const key = match[1];
    if (key !== undefined && key in en) found.add(key);
  }
  return [...found];
}

const wordsIn = (text: string) =>
  text
    .replace(/\{[^}]+\}/g, "x")
    .split(/\s+/)
    .filter(Boolean).length;

/** What a page says on demand, not as a line. */
const ON_DEMAND = /\.(tip|details)$/;

/** An error, a problem or a state a failure leaves: said where it happened, in as many words as it takes. */
const ERROR =
  /(\.error|\.problem|\.failed|\.expired|keyMissing|keyCharacter|loadFailed|unreachable|unconfirmed|too-large)/;

/**
 * Consent facts: what goes where, who receives it, what a choice allows
 * (ADR-0022), and the security facts of keys and scripts. Each stays as long
 * as it needs to be to say it.
 */
const CONSENT_FACTS = [
  "agents.connect.allUnfiled",
  "agents.connect.body",
  "connectors.directory.where.body",
  "connectors.form.sends",
  "connectors.import.sends",
  "embeddingProviders.confirm.cloud",
  "embeddingProviders.settings.sendsTo",
  "privacy.flows.intro",
  "privacy.skills.body",
  "privacy.usageData.tester",
  "providers.secrets.plainText.accept",
  "providers.secrets.plainText.body",
  "providers.secrets.unavailable",
  "providers.sends.onRequest",
  "rerank.settings.sends",
  "tagging.automatic.sends",
  // What first run's key field and sorting choice send, and where (ADR-0022).
  "needsModel.organize",
  "needsModel.compare",
  "needsModel.help",
  "setup.sorting.here",
  "setup.sorting.chatHere",
  "setup.sorting.sends",
];

describe("The Settings pages", () => {
  const lines = sources().flatMap((file) =>
    keysIn(file.text)
      .filter((key) => !ON_DEMAND.test(key) && !ERROR.test(key) && !CONSENT_FACTS.includes(key))
      .map((key) => ({ file: file.name, key, text: en[key as keyof typeof en] })),
  );

  test("read the strings of every Settings component", () => {
    expect(lines.length).toBeGreaterThan(300);
  });

  test("have no line over ten words, apart from consent facts and errors", () => {
    const long = lines
      .filter((line) => wordsIn(line.text) > 10)
      .map((line) => `${line.key} (${wordsIn(line.text)} words, in ${line.file}): ${line.text}`);
    expect(long).toEqual([]);
  });

  test("keep consent facts only as the list names them", () => {
    for (const key of CONSENT_FACTS) expect(key in en, `${key} is no longer a string`).toBe(true);
  });
});
