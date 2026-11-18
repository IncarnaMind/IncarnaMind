/**
 * The footer's "4 to organize · Allow {service}" (#2308, #3353, ADR-0022): the press is the User's
 * consent for the services it names, which turns sorting new Documents on there, and then the
 * Documents that waited are read as the User's own request: Organize plans them into the Review
 * (#1569) where there are Folders to sort into, and a re-tag proposes their Tags where there are
 * none. Nothing went to the services before.
 */
import type { ExternalService } from "../../core/api";
import { core } from "./core";
import { organizeDocuments } from "./organizeDocuments";
import { useAppStore } from "./store";

export async function allowAndSort(
  documentIds: readonly string[],
  services: readonly ExternalService[],
): Promise<void> {
  const app = useAppStore.getState();
  const library = app.library;
  if (!library) return;
  try {
    await core.saveLibrarySettings({ ...library.settings, automatic: true, turnOn: true });
    if (library.groups.length > 0) {
      // The row said what Organize sends, so its own card doesn't ask again.
      for (const service of services) await core.allowOrganize(service.id);
      await app.refreshLibrary();
      await organizeDocuments(documentIds);
    } else {
      await core.retagDocuments([...documentIds]);
      await app.refreshLibrary();
    }
  } catch (error) {
    app.reportError(error);
  }
}

/** The row's no: the switch goes off as the User's own choice, and no row asks again (#3353). */
export async function keepSortingOff(): Promise<void> {
  const app = useAppStore.getState();
  const settings = app.library?.settings;
  if (!settings) return;
  try {
    await core.saveLibrarySettings({ ...settings, automatic: false, turnOn: false });
    await app.refreshLibrary();
  } catch (error) {
    app.reportError(error);
  }
}
