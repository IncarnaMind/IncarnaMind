/**
 * A path under the home folder written from "~", as a terminal shows it, for a line the User
 * reads; any other path as it is. The separator after the home folder stays the path's own.
 */
export function pathFromHome(path: string, home: string): string {
  const windows = /^[A-Za-z]:[\\/]/.test(home);
  const folder = home.replace(/[\\/]+$/, "");
  const same = (a: string, b: string) => (windows ? a.toLowerCase() === b.toLowerCase() : a === b);
  if (folder === "") return path;
  if (same(path, folder)) return "~";
  const next = path.charAt(folder.length);
  return same(path.slice(0, folder.length), folder) && (next === "/" || next === "\\")
    ? `~${path.slice(folder.length)}`
    : path;
}
