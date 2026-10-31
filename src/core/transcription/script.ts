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

/** Text with its Chinese in `script`; text with none is returned as it is. */
export function inScript(text: string, script: ChineseScript): string {
  return HAN.test(text) ? converterOf(script)(text) : text;
}
