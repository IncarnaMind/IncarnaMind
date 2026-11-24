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

/** What makes up the Settings pages: each page's files, and the folders of the Agents, AI and Connectors pages. */
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
  "TaskNotificationSettings.tsx",
];
const FOLDERS = ["agents", "ai", "connectors", "providers", "settings"];
/** First-run screens in those folders: not Settings. */
const NOT_SETTINGS = new Set([
  "ModelSetupCard.tsx",
  "SetupWays.tsx",
  "GetOllama.tsx",
  "OllamaCard.tsx",
]);

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
  // What it may read and where that goes, in the line the User reads before they allow (#3487),
  // with the Folders all leaves out (#3544), and what a connected agent reads, in those words.
  "agents.connect.reads.all",
  "agents.connect.reads.walled",
  "agents.pairing.readsAll",
  "agents.connect.backup",
  "agents.connect.body",
  // That connecting Claude Code lets IncarnaMind start it for a check, on the User's plan (#3606),
  // and Codex too, which reads the User's own instructions file in those runs (#3639).
  "agents.connect.background",
  "agents.connect.background.codex",
  "agents.connect.codexInstructions",
  // What the leave to write allows: a check of its notes goes to the User's AI model (#3317), and
  // IncarnaMind copies the files it names for a Canvas (#3406).
  "agents.propose.hint",
  "connectors.directory.where.body",
  "connectors.form.sends",
  "connectors.import.sends",
  "connectors.import.placeholder",
  "embeddingProviders.confirm.cloud",
  "embeddingProviders.settings.sendsTo",
  "privacy.flows.intro",
  // What the AI use record sends while usage data is on (ADR-0014, #1993).
  "privacy.aiUse.private",
  "privacy.skills.body",
  "privacy.usageData.tester",
  "providers.secrets.plainText.accept",
  "providers.secrets.plainText.body",
  "providers.secrets.unavailable",
  "providers.sends.onRequest",
  "rerank.settings.sends",
  // A page loaded as a browser would reach every host it loads anything from (#2553).
  "webPages.keepLook.body",
  // What first run's key field and sorting choice send, and where (ADR-0022).
  "setup.key.sends",
  // What is sent where a service is chosen, and the GitHub sign-in's notice (#2900).
  "providers.sendsLine",
  "copilot.notice.sends",
  "needsModel.compare",
  "needsModel.help",
  "setup.sorting.here",
  "setup.sorting.chatHere",
  "setup.sorting.sendsWhenOn",
  // Which service isn't allowed yet, while sorting new Documents asks before the first one goes (#3353).
  "ai.organize.automatic.asks",
  // What a check sends to the decision model's host, where its switch is turned on or it is on by default (#3118).
  "ai.jobs.checks.sends",
  "ai.jobs.checks.sendsByDefault",
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
