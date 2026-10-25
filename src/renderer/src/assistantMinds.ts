/**
 * A Mind the assistant makes (#202) opens in the window whose Question asked
 * for it: in a new tab beside the focused one, as Add to note's New Mind does,
 * as soon as the call that makes it has made it. Other windows showing the same
 * conversation leave their tabs as they are.
 */
import { core } from "./core";
import { useAppStore } from "./store";

/** Answers to Questions asked in this window, still being written. */
const askedHere = new Set<string>();
/** Minds already opened for the Answer that made them. */
const opened = new Set<string>();

/** An Answer this window asked for: a Mind it makes opens here. */
export function watchMindsMadeBy(answerId: string): void {
  askedHere.add(answerId);
}

core.on("conversation.message", (message) => {
  if (message.kind !== "answer" || !askedHere.has(message.id)) return;
  for (const call of message.toolCalls) {
    // As soon as it is made: its text may still be coming in (#202).
    const made =
      call.status !== "failed" && call.mindChange?.created ? call.mindChange.mindId : null;
    if (!made || opened.has(made)) continue;
    opened.add(made);
    useAppStore
      .getState()
      .changeLayout({ type: "open", item: { kind: "mind", mindId: made }, where: { in: "place" } })
      .catch(useAppStore.getState().reportError);
  }
  if (message.status !== "streaming") askedHere.delete(message.id);
});
