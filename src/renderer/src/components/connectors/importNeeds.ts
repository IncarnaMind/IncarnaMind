import type { ConnectorImportEntry } from "../../../../core/api";

/**
 * Whether importing these Connectors needs the keychain: environment values and header values are
 * stored, while an imported `${env:NAME}` header keeps its name and stores nothing (#2025).
 */
export function importNeedsKeychain(entries: readonly ConnectorImportEntry[]): boolean {
  return entries.some(
    (entry) =>
      entry.env.length > 0 ||
      (entry.headers ?? []).some(
        (header) => !(entry.placeholders ?? []).some((each) => each.header === header),
      ),
  );
}
