import { describe, expect, test } from "vitest";
import { LANGUAGES } from "../../src/core/language";
import { translate } from "../../src/shared/i18n";
import {
  GENERAL_HELP,
  helpLabel,
  type MeetingHelpKind,
  pressedHelp,
  TEMPLATE_HELP,
} from "../../src/shared/meetingHelp";

const EVERY_BUTTON: readonly MeetingHelpKind[] = [
  ...GENERAL_HELP,
  ...Object.values(TEMPLATE_HELP).flat(),
];
const WITH_THE_CALL = { steps: { sent: { documents: [], transcript: true as const } } };

describe("A turn taken for a help button's press (#3005)", () => {
  test("every button's name, in either language, with the call's live text, gives that button", () => {
    expect(EVERY_BUTTON).toHaveLength(15);
    for (const kind of EVERY_BUTTON) {
      for (const language of LANGUAGES) {
        const text = translate(language, helpLabel(kind));
        expect(pressedHelp({ text }, WITH_THE_CALL), `${kind} in ${language}`).toBe(kind);
      }
    }
  });

  test("a typed Question, or a button's name sent without the call's live text, is no press", () => {
    expect(pressedHelp({ text: "What did they say last time?" }, WITH_THE_CALL)).toBeNull();
    expect(pressedHelp({ text: "上次他们说了什么？" }, WITH_THE_CALL)).toBeNull();
    for (const kind of EVERY_BUTTON) {
      for (const language of LANGUAGES) {
        const question = { text: translate(language, helpLabel(kind)) };
        expect(pressedHelp(question, { steps: { sent: { documents: [] } } })).toBeNull();
        expect(pressedHelp(question, { steps: {} })).toBeNull();
        expect(pressedHelp(question, { steps: null })).toBeNull();
      }
    }
  });
});
