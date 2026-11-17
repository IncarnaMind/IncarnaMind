/**
 * "What files do I have" names every Document, the ones IncarnaMind couldn't read among them
 * (#2525): the Library's whole count includes a damaged file, a password-protected one and a scan
 * with no text, none of which a search finds anything in, so a model that listed only the names of
 * the Documents it can use said 25 and listed 24, and couldn't name the 25th. Its instructions
 * name them, with why, beside the Library's count.
 */
import { describe, expect, test } from "vitest";
import { askAndFinish, type SourceFile, setUpWithDocuments } from "../helpers/citations";
import { type ModelCall, scriptedModel } from "../helpers/models";
import { buildPdf } from "../helpers/pdf";

const QUESTION = "What files do I have?";

const READABLE: SourceFile[] = [
  {
    name: "Tariffs 2024.md",
    contents: "# Harbour tariffs 2024\n\nA 10 metre boat pays 40 euros.\n",
  },
  { name: "Crew roster.txt", contents: "Crew roster: Ines, Tomas and Wren on the early shift." },
];
const DAMAGED: SourceFile = { name: "Damaged draft.pdf", contents: "This isn't a PDF." };
const SCAN: SourceFile = { name: "Harbour notice.pdf", contents: buildPdf([{ image: true }]) };

/** The Document names a model's instructions list, in order. */
function listedNames(system: string): string[] {
  const lines = system.split("\n");
  const from = lines.findIndex((line) =>
    /^(?:Its name|Their names, newest first|The names of the \d+ added most recently):$/.test(line),
  );
  if (from < 0) return [];
  const names: string[] = [];
  for (const line of lines.slice(from + 1)) {
    if (!line.startsWith("- ")) break;
    names.push(line.slice(2));
  }
  return names;
}

/** The instructions of the first request an Answer to the Question sends. */
async function instructionsFor(files: SourceFile[]): Promise<string> {
  const seen: string[] = [];
  const model = scriptedModel((call: ModelCall) => {
    seen.push(call.system);
    return { text: "Here are your files." };
  });
  const { core, client, mind } = await setUpWithDocuments(model, files);
  await askAndFinish(core, client, mind.id, QUESTION);
  core.close();
  return seen[0] ?? "";
}

describe("a model asked what files there are is told the ones that couldn't be read", () => {
  // protects=the instructions of an Answer name each Document of the Library that couldn't be read, with why, beside the Library's count, so a model asked what files there are names it (#2525); fails_when=the Library's count says 3 and only the 2 readable names are listed
  test("names a damaged file and a scan with no text, with why", async () => {
    const system = await instructionsFor([...READABLE, DAMAGED, SCAN]);
    expect(listedNames(system).map((name) => name.split(" (")[0])).toEqual(
      expect.arrayContaining(["Tariffs 2024", "Crew roster"]),
    );
    expect(system).toContain('"Damaged draft.pdf" (damaged or couldn\'t be opened)');
    expect(system).toContain('"Harbour notice.pdf" (a scan with no text)');
  });

  // protects=an Answer in a Library whose Documents were all read is told of none that couldn't be (#2525); fails_when=the note names a Document that was read
  test("says nothing when every Document was read", async () => {
    const system = await instructionsFor(READABLE);
    expect(system).not.toContain("couldn't be read");
    expect(system).not.toContain("damaged or couldn't be opened");
  });

  // protects=the readable Documents are listed as before, no fewer, whether or not some couldn't be read (#2525); fails_when=naming the unreadable ones takes a readable one out of the list
  test("lists the readable Documents as before", async () => {
    const without = await instructionsFor(READABLE);
    const withUnread = await instructionsFor([...READABLE, DAMAGED]);
    expect(listedNames(withUnread)).toEqual(listedNames(without));
  });
});
