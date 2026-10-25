import { core } from "./core";
import { useAppStore } from "./store";
import { useUndo } from "./undo";

/** Local mode ("Keep everything on this computer") on or off, in this window's state too. */
async function setLocalMode(enabled: boolean): Promise<void> {
  useAppStore.setState({ embedding: await core.setLocalOnly(enabled) });
}

/**
 * Turns local mode off where a Question was refused, and offers Undo, which
 * turns it on again (and so keeps a cloud model from receiving anything): at
 * the sidebar's foot, or at `shownAt` where Settings holds the choice.
 */
export async function turnOffLocalMode(shownAt?: string): Promise<void> {
  await setLocalMode(false);
  useUndo.getState().push({
    said: (t) => t("localMode.turnedOff"),
    undo: () => setLocalMode(true),
    redo: () => setLocalMode(false),
    ...(shownAt && { shownAt }),
  });
}

/**
 * Local mode was just turned on or off from choosing a local model: this
 * window learns of it, and the change offers Undo, as turning it off does:
 * at the sidebar's foot, or at `shownAt` where Settings holds the choice.
 */
export async function localModeChosen(wasOn: boolean, shownAt?: string): Promise<void> {
  const embedding = await core.getEmbeddingSettings();
  useAppStore.setState({ embedding });
  if (embedding.localOnly === wasOn) return;
  const now = embedding.localOnly;
  useUndo.getState().push({
    said: (t) => t(now ? "localMode.turnedOn" : "localMode.turnedOff"),
    undo: () => setLocalMode(wasOn),
    redo: () => setLocalMode(now),
    ...(shownAt && { shownAt }),
  });
}
