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

/**
 * The engines a test build runs as stand-ins, with a flag each: the search model (and the
 * reranking model beside it), text recognition and speech-to-text.
 */
export const ENGINES = ["embedder", "ocr", "transcriber"] as const;
export type Engine = (typeof ENGINES)[number];

const STAND_IN_FLAGS: Record<Engine, string> = {
  embedder: "INCARNAMIND_TEST_EMBEDDER",
  ocr: "INCARNAMIND_TEST_OCR",
  transcriber: "INCARNAMIND_TEST_TRANSCRIBER",
};

/**
 * The flags that make every engine a stand-in but those in `real`, which the app runs as the
 * User's copy does. With any, the test build may also reach the model hosts, so that engine's
 * model downloads into the launch's data folder.
 */
export function standIns(real: readonly Engine[] = []): Record<string, string | undefined> {
  return {
    ...Object.fromEntries(
      ENGINES.map((engine) => [STAND_IN_FLAGS[engine], real.includes(engine) ? undefined : "fake"]),
    ),
    INCARNAMIND_TEST_MODEL_HOSTS: real.length > 0 ? "1" : undefined,
  };
}
