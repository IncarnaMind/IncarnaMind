import { core } from "./core";
import { useAppStore } from "./store";

/**
 * Exports a Mind's AI use statement (#739): the core makes it as a new Mind,
 * which opens in a new tab beside the one in front, so the User can edit it. The
 * Mind the statement is of is left as it is. Like any Mind made, it says nothing,
 * and Delete takes it back.
 */
export async function exportAiUseStatement(mindId: string): Promise<void> {
  try {
    const mind = await core.createAiUseStatement(mindId);
    await useAppStore.getState().showNewMind(mind);
  } catch (error) {
    useAppStore.getState().reportError(error);
  }
}
