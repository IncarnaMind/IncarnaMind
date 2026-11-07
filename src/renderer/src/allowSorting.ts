/**
 * The footer's "4 to organize · Allow {service}" (#2308, ADR-0022): the press is the User's consent
 * for that service alone, which turns sorting new Documents on there, and then Organize sorts the
 * Documents that waited, with its one Undo. Nothing went to the service before.
 */
import { core } from "./core";
import { organizeDocuments } from "./organizeDocuments";
import { useAppStore } from "./store";

export async function allowAndSort(documentIds: readonly string[]): Promise<void> {
  const app = useAppStore.getState();
  const settings = app.library?.settings;
  if (!settings) return;
  try {
    await core.saveLibrarySettings({ ...settings, automatic: true, turnOn: true });
    await app.refreshLibrary();
    await organizeDocuments(documentIds);
  } catch (error) {
    app.reportError(error);
  }
}
