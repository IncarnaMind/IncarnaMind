import type { ChangeRefusalKind } from "../core/api";
import type { MessageKey } from "./i18n/types";

/**
 * The words for why a model's change to a Note was refused (#2796), a kind to an entry, wherever
 * it is said: the line under Edit with AI (`editor`), the assistant's card for a call that changed
 * nothing (`card`, with the Note's name), the outside agent's error (`agent`, with the paragraph's
 * name), and the reason the assistant's model reads (`model`, never shown, so English only).
 */
export const REFUSAL_WORDS = {
  "not-placed": {
    editor: "edit.problem.not-placed",
    card: "mindCall.failed.notPlaced",
    agent: "agents.propose.unplaced",
    model: "the rewrite would hold a Citation, footnote or figure its reply didn't place",
  },
  misnamed: {
    editor: "edit.problem.misnamed",
    card: "mindCall.failed.misnamed",
    agent: "agents.propose.misnamed",
    model: "the rewrite didn't say clearly which paragraph each of its own replaces",
  },
  "typed-tag": {
    editor: "edit.problem.typed-tag",
    card: "mindCall.failed.typedTag",
    agent: "agents.propose.typedTag",
    model: "the rewrite left out a <removed> tag the User typed",
  },
  "missing-number": {
    editor: "edit.problem.missing-number",
    card: "mindChanges.missingNumberRefused.one",
    agent: "agents.propose.missingNumber",
    model:
      "the change took out [number missing], which only a calculated figure may take the place of",
  },
  "no-table": {
    editor: "edit.problem.no-table",
    card: "mindCall.failed.noTable",
    agent: "agents.propose.table",
    model: "its table couldn't be made",
  },
  unplaced: {
    editor: "edit.problem.unplaced",
    card: "mindCall.failed.unplaced",
    agent: "agents.propose.table",
    model: "the text it marked to take out isn't there word for word",
  },
} as const satisfies Record<
  ChangeRefusalKind,
  { editor: MessageKey; card: MessageKey; agent: MessageKey; model: string }
>;
