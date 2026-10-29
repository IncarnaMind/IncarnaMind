/**
 * How the engines load their native modules, and the packaged app's check that they do (#1239).
 * A loader gives its module only once it has every function the app calls from it, and otherwise
 * fails naming the module: a module can load differently in the built app (a CommonJS package
 * reached through a native `import()`, an addon left inside app.asar), where the tests' fake
 * engines never look. Each is imported only when an engine needs it: the native runtimes are
 * large. No Electron imports: the engine processes and the unit tests load these.
 */

export interface EngineModule<T = unknown> {
  /** The package, as a failure names it. */
  readonly name: string;
  load(): Promise<T>;
}

/** One module an engine process loaded: `problem` is null when it loaded. */
export interface EngineModuleCheck {
  module: string;
  problem: string | null;
}

/** Starts an engine process only to load its modules and answer what it found (src/main/engineCheck.ts). */
export const ENGINE_CHECK_ARGUMENT = "--check-modules";

const memberAt = (value: unknown, path: string): unknown =>
  path
    .split(".")
    .reduce<unknown>(
      (at, key) =>
        (typeof at === "object" && at !== null) || typeof at === "function"
          ? Reflect.get(at, key)
          : undefined,
      value,
    );

/** `calls`: the functions the app calls from it, as paths such as "OfflineRecognizer.createAsync". */
export function engineModule<T>(
  name: string,
  load: () => Promise<T>,
  calls: readonly string[],
): EngineModule<T> {
  return {
    name,
    async load() {
      const loaded = await load();
      const missing = calls.filter((path) => typeof memberAt(loaded, path) !== "function");
      if (missing.length > 0) throw new Error(`${name} loaded without ${missing.join(", ")}`);
      return loaded;
    },
  };
}

function hasDefault<T extends object>(loaded: T | { default: T }): loaded is { default: T } {
  return "default" in loaded;
}

/**
 * A CommonJS package's exports. A native `import()` of one, as the built processes make, has all
 * of them on `default`: Node finds named ones only where it can read them off the file. A
 * bundler's interop has both.
 */
export const exportsOf = <T extends object>(loaded: T | { default: T }): T =>
  hasDefault(loaded) ? loaded.default : loaded;

/** Runs the embedding, reranking and text recognition models. */
export const ONNX_RUNTIME = engineModule("onnxruntime-node", () => import("onnxruntime-node"), [
  "InferenceSession.create",
  "Tensor",
]);

export const TOKENIZERS = engineModule(
  "@huggingface/tokenizers",
  () => import("@huggingface/tokenizers"),
  ["Tokenizer"],
);

/** Loads each in turn; a failure is reported, never thrown. */
export async function checkEngineModules(
  modules: readonly EngineModule[],
): Promise<EngineModuleCheck[]> {
  const found: EngineModuleCheck[] = [];
  for (const each of modules) {
    try {
      await each.load();
      found.push({ module: each.name, problem: null });
    } catch (error) {
      found.push({
        module: each.name,
        problem: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return found;
}

/** What an engine process started with ENGINE_CHECK_ARGUMENT does instead of serving. */
export function answerEngineCheck(
  port: { postMessage(found: EngineModuleCheck[]): void },
  modules: readonly EngineModule[],
): void {
  void checkEngineModules(modules).then((found) => port.postMessage(found));
}
