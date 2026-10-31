/**
 * The benchmark's own settings, from INCARNAMIND_EVAL_CITATIONS_* variables
 * (eval/citations/README.md). The model asked is set as for `npm run eval`.
 */
import { isAbsolute, join, resolve } from "node:path";
import { LANGUAGES, type Language } from "./runs";

type Env = Readonly<Record<string, string | undefined>>;

const PREFIX = "INCARNAMIND_EVAL_CITATIONS_";

const value = (env: Env, name: string) => env[`${PREFIX}${name}`]?.trim() || null;

export interface BenchmarkSettings {
  /** The smoke tests' scripted chat model instead of a real one: a check of the pipeline. */
  scripted: boolean;
  languages: Language[];
  /** The most a run, or the judging, may spend, in US dollars. */
  capUsd: number | null;
  check: boolean;
  /** The folder of the run files, the judgements, the scores and the results page. */
  runsDir: string;
  /** A file of words no published file may hold, kept outside the repository; null: none. */
  denyList: string | null;
}

export const DEFAULT_RUNS = "eval/citations/runs";

export function readSettings(root: string, env: Env = process.env): BenchmarkSettings {
  const languages = value(env, "LANGUAGES");
  const chosen = languages
    ? languages.split(",").map((each) => {
        const found = LANGUAGES.find((language) => language === each.trim());
        if (!found) throw new Error(`${PREFIX}LANGUAGES takes en, zh or both, not "${each}".`);
        return found;
      })
    : [...LANGUAGES];
  const cap = value(env, "CAP_USD");
  const capUsd = cap === null ? null : Number(cap);
  if (capUsd !== null && !(Number.isFinite(capUsd) && capUsd >= 0)) {
    throw new Error(`${PREFIX}CAP_USD is an amount in US dollars, such as 25, not "${cap}".`);
  }
  const check = value(env, "CHECK");
  if (check !== null && check !== "on" && check !== "off") {
    throw new Error(`${PREFIX}CHECK is "on" (the default) or "off", not "${check}".`);
  }
  const runs = value(env, "RUNS") ?? DEFAULT_RUNS;
  const denyList = value(env, "DENY_LIST");
  return {
    scripted: value(env, "SCRIPTED") === "1",
    languages: [...new Set(chosen)],
    capUsd,
    check: check !== "off",
    runsDir: isAbsolute(runs) ? runs : join(root, runs),
    denyList: denyList === null ? null : resolve(denyList),
  };
}
