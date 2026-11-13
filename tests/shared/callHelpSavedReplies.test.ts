/**
 * The evaluation's "as before" arm reads call help's replies exactly as main does (#2847), so the
 * form's trial compares main with the form and nothing else. The fixture holds 133 replies a real
 * model wrote in a development trial of call help, as the panel showed them with their numbers turned
 * back into markers, each with the hash of main's own reading of it (its text kept, the line put
 * first and the options, readings or short lines), taken by running main's reader.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { helpReplyRead, type ReplyItem } from "../../src/shared/helpReplyRead";
import { HELP_SHAPE, type MeetingHelpKind } from "../../src/shared/meetingHelp";

const saved: { kind: MeetingHelpKind; text: string; main: string }[] = JSON.parse(
  readFileSync(join(__dirname, "../fixtures/callHelp/savedReplies.json"), "utf8"),
);

/** An item as main reads it: without the form's own lines and those after its "→" line, which main has none of. */
const strip = (items: readonly ReplyItem[]) =>
  items.map(({ own: _own, after: _after, ...item }) => item);

describe("the as-before arm reads every saved reply as main does", () => {
  // protects=main's reading of 133 real replies, its text kept and every item with each chip's place, is what the evaluation's as-before arm reads, byte for byte; fails_when=the reader changes main's reading of any of them; no_claim=how the form reads them.
  test("133 replies, each read to main's own hash", () => {
    expect(saved).toHaveLength(133);
    const differ = saved.filter(({ kind, text, main }) => {
      const read = helpReplyRead(text, {
        shape: HELP_SHAPE[kind],
        leadIn: kind === "leading",
        streaming: false,
        form: "as before",
      });
      const hash = createHash("sha256")
        .update(
          JSON.stringify({ text: read.text, lead: strip(read.lead), options: strip(read.options) }),
        )
        .digest("hex");
      const apart =
        read.opening.length > 0 ||
        read.closing.length > 0 ||
        [...read.lead, ...read.options].some((item) => item.after.length > 0);
      return hash !== main || apart;
    });
    expect(differ.map(({ text }) => text.slice(0, 60))).toEqual([]);
  });
});
