/**
 * With INCARNAMIND_LIVE_MEASURES naming a file, a live run keeps each figure's measure as the
 * check read it, the texts it looked in and what it found, one line a figure, so the model's
 * replies can be replayed through other code without the prompts (#2255).
 */
import { appendFileSync } from "node:fs";
import type * as Measures from "../../src/core/answers/checks/figureMeasures";

export function keptMeasures(module: typeof Measures): typeof Measures {
  const file = process.env.INCARNAMIND_LIVE_MEASURES;
  if (!file) return module;
  return {
    ...module,
    measureFinding: (measure, sentence, quote, bound, passage) => {
      const texts = passage();
      const found = module.measureFinding(measure, sentence, quote, bound, () => texts);
      const line = { measure, sentence, quote, bound, passage: texts, found };
      appendFileSync(file, `${JSON.stringify(line)}\n`);
      return found;
    },
  };
}
