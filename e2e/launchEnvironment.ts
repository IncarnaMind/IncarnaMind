/**
 * What an app started by a test or a recording takes from the environment it was started in: only
 * what it needs to run on this computer. Playwright keeps a traced launch's whole environment in
 * the trace, and the app passes its own to every process it starts, so an API key, a token or a
 * proxy's password in a developer's shell must never reach it (#2164).
 */
const INHERITED = new Set([
  "PATH",
  "HOME",
  "TMPDIR",
  "TEMP",
  "TMP",
  "LANG",
  "LANGUAGE",
  "TZ",
  "DISPLAY",
  "WAYLAND_DISPLAY",
  "XAUTHORITY",
  "XDG_RUNTIME_DIR",
  "XDG_SESSION_TYPE",
  "DBUS_SESSION_BUS_ADDRESS",
  "SYSTEMROOT",
  "WINDIR",
  "COMSPEC",
  "PATHEXT",
  "APPDATA",
  "LOCALAPPDATA",
  "USERPROFILE",
]);

// Windows names them in any case: Path, SystemRoot, windir.
const inherited = (name: string): boolean => {
  const upper = name.toUpperCase();
  return INHERITED.has(upper) || /^LC_[A-Z]+$/.test(upper);
};

/**
 * The launch's own values, by name, over what it inherits from `parent`. An own value left
 * undefined is not set, so a launch can list the ones an option turns on.
 */
export function launchEnvironment(
  own: Readonly<Record<string, string | undefined>>,
  parent: Readonly<Record<string, string | undefined>> = process.env,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(parent)) {
    if (value !== undefined && inherited(name)) env[name] = value;
  }
  for (const [name, value] of Object.entries(own)) {
    if (value !== undefined) env[name] = value;
  }
  return env;
}
