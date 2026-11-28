import { useEffect } from "react";
import { create } from "zustand";
import { core } from "./core";

const CHANGES = [
  "chatReadiness.changed",
  "settings.changed",
  "jev.changed",
  "decisions.changed",
  "dataFlows.changed",
  "library.changed",
] as const;

/** Whether anything can tag Documents now, as the core routes tagging; false until known. */
const useCanTag = create<{ canTag: boolean }>(() => ({ canTag: false }));

export const canTagNow = (): boolean => useCanTag.getState().canTag;

/**
 * Keeps `canTagNow` as the core says, a chat model, a decision model host or Jev being what can
 * tag: read as the window opens and again whenever any of them changes.
 */
export function useCanTagRead(): void {
  useEffect(() => {
    let newest = 0;
    const read = () => {
      newest += 1;
      const mine = newest;
      core.getTaggingRoute("tagging").then(
        (route) => {
          if (mine === newest) useCanTag.setState({ canTag: route.where !== "none" });
        },
        (failure: unknown) => console.error("What can tag Documents couldn't be read.", failure),
      );
    };
    read();
    const stops = CHANGES.map((event) => core.on(event, read));
    return () => {
      newest = Number.NaN;
      for (const stop of stops) stop();
    };
  }, []);
}
