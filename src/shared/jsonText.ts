// biome-ignore lint/suspicious/noControlCharactersInRegex: they are what it looks for
const CONTROL = /[\u0000-\u001f\u007f]/;

/**
 * JSON text with the control characters inside its strings escaped (a raw tab, line feed or
 * carriage return), which JSON's own reader refuses ("Bad control character in string
 * literal"). Writers that copy text into a string as it is send them: an engine's result
 * (#981), a model's Tool call that quotes a sheet row (#1827).
 */
export function escapedInStrings(json: string): string {
  let out = "";
  let inString = false;
  for (let at = 0; at < json.length; at++) {
    const char = json.charAt(at);
    if (!inString) {
      inString = char === '"';
      out += char;
    } else if (char === "\\") {
      out += char + json.charAt(++at);
    } else {
      if (char === '"') inString = false;
      out += CONTROL.test(char) ? `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}` : char;
    }
  }
  return out;
}
