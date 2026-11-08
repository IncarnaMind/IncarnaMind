/**
 * A Mind the assistant makes (#202) opens in the window whose Question asked
 * for it: in a new tab beside the focused one, as Add to note's New Mind does,
 * as soon as the call that makes it has made it. Other windows showing the same
 * conversation leave their tabs as they are.
 */
import type { TabItem } from "../../core/api";
import { core } from "./core";
import { currentTabOf, sameTabItem } from "./layoutSlice";
import { useAppStore } from "./store";

/** Answers to Questions asked in this window, still being written. */
const askedHere = new Set<string>();
/** By Answer: the place in front when this window asked for it (#2572). */
const askedFrom = new Map<string, TabItem | null>();
/** Minds already opened for the Answer that made them. */
const opened = new Set<string>();

/** An Answer this window asked for: a Mind it makes opens here, unless the User goes elsewhere. */
export function watchMindsMadeBy(answerId: string, askedFromItem: TabItem | null): void {
  askedHere.add(answerId);
  askedFrom.set(answerId, askedFromItem);
}

/** An Answer nothing will be written for: forget where it was asked. */
export function forgetMindsMadeBy(answerId: string): void {
  askedHere.delete(answerId);
  askedFrom.delete(answerId);
}

core.on("conversation.message", (message) => {
  if (message.kind !== "answer" || !askedHere.has(message.id)) return;
  for (const call of message.toolCalls) {
    // As soon as it is made: its text may still be coming in (#202).
    const made =
      call.status !== "failed" && call.mindChange?.created ? call.mindChange.mindId : null;
    if (!made || opened.has(made)) continue;
    opened.add(made);
    // A made Note stays behind when the User has gone elsewhere since they asked (#2572).
    const stillThere = sameTabItem(
      currentTabOf(useAppStore.getState().layout)?.item ?? null,
      askedFrom.get(message.id) ?? null,
    );
    useAppStore
      .getState()
      .changeLayout({
        type: "open",
        item: { kind: "mind", mindId: made },
        where: { in: "place" },
        behind: !stillThere,
      })
      .catch(useAppStore.getState().reportError);
  }
  if (message.status !== "streaming") {
    askedHere.delete(message.id);
    askedFrom.delete(message.id);
  }
});
