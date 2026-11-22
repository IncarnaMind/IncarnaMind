/**
 * The app's own links (#3534, ADR-0033): one item by its id, `incarnamind://note/<id>`,
 * `…/file/<id>` or `…/canvas/<id>`. A link only shows its item; it carries no name, path, text,
 * query or fragment, and anything else in the app's scheme only brings the app forward. Every link
 * the app is handed, from the system or a start's arguments, is read here and nowhere else.
 */

/** The scheme the app's links use, as electron-builder.yml and build/installer.nsh register it. */
export const APP_LINK_SCHEME = "incarnamind";

export const APP_LINK_KINDS = ["note", "file", "canvas"] as const;
export type AppLinkKind = (typeof APP_LINK_KINDS)[number];

export interface AppLinkItem {
  kind: AppLinkKind;
  id: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The link that shows `item`. */
export const appLink = ({ kind, id }: AppLinkItem): string =>
  `${APP_LINK_SCHEME}://${kind}/${id.toLowerCase()}`;

/** Whether `text` is in the app's scheme at all, whatever follows (a URL's scheme reads in any case). */
export const isAppLink = (text: string): boolean =>
  text.slice(0, APP_LINK_SCHEME.length + 3).toLowerCase() === `${APP_LINK_SCHEME}://`;

/**
 * The item a link names, or null for any other shape: another kind, an id that isn't a UUID, a
 * second path part, a query, a fragment, user info or a port. Null still brings the app forward.
 */
export function readAppLink(text: string): AppLinkItem | null {
  if (!isAppLink(text) || text.length > 200) return null;
  const rest = text.slice(APP_LINK_SCHEME.length + 3);
  const match = /^([a-z]+)\/([0-9a-f-]+)$/.exec(rest);
  if (!match) return null;
  const [, kind = "", id = ""] = match;
  const known = APP_LINK_KINDS.find((each) => each === kind);
  return known && UUID.test(id) ? { kind: known, id } : null;
}

/** The first argument of a start that is in the app's scheme (Windows and Linux pass a link so). */
export const appLinkIn = (args: readonly string[]): string | null => args.find(isAppLink) ?? null;
