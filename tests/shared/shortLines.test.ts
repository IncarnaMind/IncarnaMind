/**
 * Every line the interface shows is one short sentence, then its actions (#3756). A template is
 * measured as written, placeholders included: English in characters, Chinese in columns, where a
 * Chinese character or a full-width mark takes two.
 */
import { describe, expect, test } from "vitest";
import { en } from "../../src/shared/i18n/en";
import type { MessageKey } from "../../src/shared/i18n/types";
import { zhCN } from "../../src/shared/i18n/zh-CN";

const LIMIT = 100;

const WIDE = /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦“”]/u;
const columns = (text: string) =>
  [...text].reduce((sum, char) => sum + (WIDE.test(char) ? 2 : 1), 0);

interface Exception {
  readonly why: string;
  readonly keys?: readonly MessageKey[];
  readonly pattern?: RegExp;
}

const EXCEPTIONS: readonly Exception[] = [
  {
    why: "Sent to the User's own AI, as a request it reads or a Tool's result: a change to one is an AI change",
    pattern:
      /^agents\.(ask|check|write|read|propose|handOver|cite|canvas|sorting|problem)\.|^agents\.notShared$/,
  },
  {
    why: "Read by a model: an instruction, a command's purpose, or a command's refusal as its Tool result",
    keys: [
      "comments.assistant.instruction",
      "meetings.template.sectionGuidance",
      "mindCheck.command.purpose",
      "error.commands.wordLoses",
      "error.folder.notFiled",
      "error.folder.wallMove",
    ],
  },
  {
    why: "Offers or explains a model set up in IncarnaMind: it leaves or changes with those entries (#3764)",
    keys: [
      "setupPage.ai.sorting.about",
      "setupPage.sorting.agentAlone",
      "providers.secrets.plainText.body",
      "providers.secrets.unavailable",
      "error.provider.openrouterCapabilities",
      "error.signIn.storeUnreadable",
      "chatgpt.signIn.error.store-unreadable",
      "answer.error.window-too-small.question",
      "answer.error.window-too-small.assistant",
      "tagging.problem.data-retention",
      "error.library.cantPropose",
      "meetings.brief.chooseModel",
      "error.meeting.briefTooLong",
      "ai.jobs.checks.tip",
      "error.research.plan.thoughtOnly",
      "answer.notCalculated.unavailable",
      "claim.reason.number-unquoted",
    ],
  },
  {
    why: "Says what leaves the computer, to whom and when: ADR-0022 keeps every fact, and only repetition goes",
    pattern:
      /^(consent\.data|privacy\.traffic|providers\.sends|status\.sends|agents\.connect\b|agents\.connectAll\.(body|reads))/,
  },
  {
    why: "Says what leaves the computer, to whom and when: ADR-0022 keeps every fact, and only repetition goes",
    keys: [
      "ai.jobs.checks.sends",
      "ai.jobs.checks.sendsByDefault",
      "copilot.notice.sends",
      "embeddingProviders.confirm.cloud",
      "embeddingProviders.settings.sendsTo",
      "export.dataFolder.logs.tip",
      "feedback.note",
      "library.organize.consent.sends",
      "library.toSort.sends.one",
      "library.toSort.sends.other",
      "library.toTag.sends.one",
      "library.toTag.sends.other",
      "meetings.brief.clientDisclosure",
      "meetings.brief.disclosure",
      "meetings.brief.localDisclosure",
      "meetings.help.agent.disclosure",
      "meetings.key.lineChecked",
      "meetings.review.disclosure",
      "meetings.route.cloudLine",
      "meetings.route.consent",
      "meetings.route.waysNote",
      "meetings.screen.picker.body",
      "meetings.summary.disclosure",
      "meetings.words.body",
      "meetings.words.bodyHere",
      "meetings.words.waiting",
      "privacy.skills.body",
      "providers.sendsLine",
      "setup.key.sends",
      "setup.sorting.asks",
      "setup.sorting.sendsWhenOn",
      "webPages.add.fetch.details.keepLook",
      "webPages.keepLook.body",
    ],
  },
  {
    why: "Behind Details, which holds the longer explanation a line leaves out",
    pattern: /\.details$/,
  },
  {
    why: "A Built-in Skill's whole description, behind Details; its line is the `.short` key",
    pattern: /^skills\.builtIn\.[\w-]+$/,
  },
  {
    why: "Words ⌘K searches by, never shown",
    pattern: /\.keywords$/,
  },
  {
    why: "Written into a file the User exports or hands on, not a line on screen",
    pattern: /^(aiStatement|checkRecord|share\.page)\./,
  },
  {
    why: "A legal caveat the User relies on, or the notice they send to everyone in the call",
    keys: [
      "claim.courtDecision.held",
      "claim.courtDecision.body",
      "claim.citedCaseUnchecked",
      "meetings.start.noticeText",
      "meetings.start.noticeText.screen",
      "meetings.start.noticeTextKept",
    ],
  },
  {
    why: "The spending cap's tip names every job the cap counts (#2835)",
    keys: ["cost.cap.tip"],
  },
  {
    why: "The example's banner: the glossary's sentence for a Note, then the one thing to try",
    keys: ["examples.banner.body", "examples.banner.body.tea"],
  },
  {
    why: "Read by a screen reader, never shown",
    keys: ["transcript.line.hintSplit"],
  },
  {
    why: "Says what data is kept on this computer and who wrote it",
    keys: ["privacy.runtimeFolder"],
  },
  {
    why: "Promises what becomes of the User's files: their Folder, new ones joining, none moved or deleted, a deck changed only by hand",
    keys: ["linkedFolders.preview.becomesFolder"],
  },
  {
    why: "Names this note's Search scope, how many Folders more, and the one file they hold",
    keys: ["checks.problem.scope.ownFile.more"],
  },
];

const excepted = (key: string) =>
  EXCEPTIONS.some((each) => each.keys?.some((listed) => listed === key) || each.pattern?.test(key));

const longer = (dictionary: Readonly<Record<string, string>>, measure: (text: string) => number) =>
  Object.entries(dictionary)
    .filter(([key, text]) => !excepted(key) && measure(text) > LIMIT)
    .map(([key, text]) => `${key} (${measure(text)}): ${text}`);

describe("an interface line is one short sentence, then its actions (#3756)", () => {
  // protects=no new interface line runs past the limit in either language unless it is named here with its reason; fails_when=a line explains, lists steps or repeats its button past 100 characters, or its Chinese past 100 columns; no_claim=that a line within the limit fits its place, which the screen decides.
  test("every English line fits the limit", () => {
    expect(longer(en, (text) => text.length)).toEqual([]);
  });

  test("every Chinese line fits the limit", () => {
    expect(longer(zhCN, columns)).toEqual([]);
  });

  // protects=the list of exceptions stays short: a named key that fits again leaves it; fails_when=a key is listed after its line was cut, or names no string; no_claim=the patterns, which cover families.
  test("a key named as an exception is still over the limit", () => {
    const listed = EXCEPTIONS.flatMap((each) => each.keys ?? []);
    expect(listed.filter((key) => en[key].length <= LIMIT)).toEqual([]);
  });
});
