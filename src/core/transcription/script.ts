/**
 * The Chinese of a Transcript in the User's script (#1031), Simplified or Traditional, through
 * OpenCC (opencc-js, MIT, with OpenCC's Apache-2.0 dictionaries). A speech model writes either, and
 * sometimes both in one call; one character alone can't say which Traditional word a Simplified
 * one is (发 is 發 or 髮), so the conversion goes by OpenCC's phrases. Traditional is Taiwan's
 * standard forms, words unchanged: 软件 stays 軟件, not 軟體.
 */
import * as toTraditional from "opencc-js/cn2t";
import * as toSimplified from "opencc-js/t2cn";
import type { ChineseScript } from "../../shared/meetingWords";

const HAN = /\p{Script=Han}/u;

const converters: Partial<Record<ChineseScript, (text: string) => string>> = {};

// Built on first use: Traditional's phrases take about 50 ms to load.
function converterOf(script: ChineseScript): (text: string) => string {
  converters[script] ??=
    script === "traditional"
      ? toTraditional.Converter({ from: "cn", to: "tw" })
      : toSimplified.Converter({ from: "tw", to: "cn" });
  return converters[script];
}

/**
 * Text with its Chinese in `script`, but for the `kept` words, written as the User writes them:
 * a name isn't a word, and OpenCC would write the surname 于 as 於 and 余 as 餘. Text with no Chinese
 * is returned as it is.
 */
export function inScript(
  text: string,
  script: ChineseScript,
  kept: readonly string[] = [],
): string {
  if (!HAN.test(text)) return text;
  const convert = converterOf(script);
  const names = kept.filter((word) => HAN.test(word)).sort((a, b) => b.length - a.length);
  let out = "";
  let rest = text;
  for (;;) {
    let at = -1;
    let name = "";
    for (const each of names) {
      const found = rest.indexOf(each);
      if (found >= 0 && (at < 0 || found < at)) {
        at = found;
        name = each;
      }
    }
    if (at < 0) return out + convert(rest);
    out += convert(rest.slice(0, at)) + name;
    rest = rest.slice(at + name.length);
  }
}
