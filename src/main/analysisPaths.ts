/**
 * What the analysis window's scheme answers a request with (ADR-0023), and
 * whether Electron runs with Chromium's sandbox: pure, so they are tested
 * without Electron.
 */
import { join, normalize, sep } from "node:path";

/**
 * The built page's file for a request's path, resolved before it is checked
 * (so "/assets/..%2Findex.html" is the app's page, and refused): the page
 * itself or a file of its assets; null for any other.
 */
export function pageFile(root: string, path: string): string | null {
  const file = normalize(join(root, path));
  if (!file.startsWith(`${root}${sep}`)) return null;
  const relative = file.slice(root.length + 1);
  return relative === "analysis.html" || relative.startsWith(`assets${sep}`) ? file : null;
}

/** Where on the dev server a request's path is; null for a path that leads off it, such as "//another-host/". */
export function devServerUrl(path: string, rendererUrl: string): string | null {
  const server = new URL(rendererUrl);
  const url = new URL(path, server);
  return url.origin === server.origin ? url.href : null;
}

/** Chromium's sandbox is off for every renderer: then the analysis window's would be too. */
export function sandboxOff(
  hasSwitch: (name: string) => boolean,
  env: Readonly<Record<string, string | undefined>>,
): boolean {
  return hasSwitch("no-sandbox") || Boolean(env.ELECTRON_DISABLE_SANDBOX);
}
