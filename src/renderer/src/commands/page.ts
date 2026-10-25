import { allOrigins, conversationOrigin } from "../../../shared/blockOrigins";
import { countShownOf, setCountShown } from "../../../shared/mindWordCount";
import { openOrigin } from "../editor/originActions";
import { useShownPages } from "../shownPages";
import type { Command, CommandContext } from "./registry";
import { mindShown, onlyOne } from "./targets";

const pageShown = (ctx: CommandContext) => {
  const mindId = mindShown(ctx);
  return mindId ? (useShownPages.getState()[mindId] ?? null) : null;
};

/** The chat the note in view came from (#1940), while it is open: a Mind not open has no copy to read it from. */
const chatShown = (ctx: CommandContext) => {
  const doc = pageShown(ctx);
  return doc ? conversationOrigin(allOrigins(doc)) : null;
};

export const pageCommands: readonly Command[] = [
  {
    id: "mind.openChat",
    label: "note.chat",
    group: "open",
    // Opening the conversation changes nothing.
    reversible: true,
    when: (ctx) => onlyOne(ctx) && chatShown(ctx) !== null,
    run: (ctx) => {
      const origin = chatShown(ctx);
      if (origin) void openOrigin(origin);
    },
  },
  {
    id: "mind.countShown",
    label: (ctx, t) => {
      const doc = pageShown(ctx);
      return t(doc && countShownOf(doc) ? "page.countHidden.command" : "page.countShown.command");
    },
    keywords: ["page.countShown.keywords"],
    group: "main",
    // Run again, it switches back; the Mind's text doesn't change.
    reversible: true,
    when: (ctx) => onlyOne(ctx) && pageShown(ctx) !== null,
    run: (ctx) => {
      const doc = pageShown(ctx);
      if (doc) setCountShown(doc, !countShownOf(doc));
    },
  },
];
