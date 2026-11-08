import { create } from "zustand";
import type { ChatModelChoice, Settings } from "../../core/api";
import { core } from "./core";

/**
 * The quick model call help may be set to answer on (#2526), for the model a new Note answers
 * on; null where none is offered. Settings › Meetings shows its row, and ⌘K its command, only
 * while there is one.
 */
export const useCallHelpOffer = create<{ fastest: ChatModelChoice | null }>()(() => ({
  fastest: null,
}));

const read = () =>
  Promise.resolve()
    .then(() => core.getModelRoles())
    .then(
      (roles) => useCallHelpOffer.setState({ fastest: roles.callHelp }),
      (error: unknown) =>
        console.error("Which model call help may answer on couldn't be read.", error),
    );

/** What the offer follows: the model a new Note answers on, and a quick model the User set. */
const followed = (settings: Settings) =>
  JSON.stringify([
    settings.device.lastChatModel,
    settings.user.chatModel,
    settings.user.quickTasksModel,
  ]);

let following = false;
/** Reads the offer now, and from the first call on, again whenever what it follows changes. */
export function loadCallHelpOffer(): void {
  void read();
  if (following) return;
  following = true;
  // A provider saved or removed changes readiness; a model chosen changes the settings.
  core.on("chatReadiness.changed", () => void read());
  let last: string | null = null;
  core.on("settings.changed", (settings) => {
    const now = followed(settings);
    if (now === last) return;
    last = now;
    void read();
  });
}
