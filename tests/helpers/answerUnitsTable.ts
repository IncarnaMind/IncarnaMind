/**
 * #2997's measured table (tests/fixtures/answerUnits/table.json): each row a sentence citing its
 * Document's words, run through the core as an Answer's sentence (its batch replying supported, or
 * the row's own reply) and through Check against Documents (its model replying the same), with what
 * each read on main and reads here. One core holds every Document of the rows it runs, and each row
 * asks with its own Documents as the Search scope.
 */
import { readFileSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { checkGenerate, checkReply, isCheckRun, type Plan } from "./checks";
import { answerEnded, answerJudged, shownPassages } from "./citations";
import { createTempDataFolder, startCore } from "./core";
import { addAndProcess, documentAt, writeSourceFile } from "./documents";
import { type ModelCall, type ScriptedReply, scriptedModel, scriptedModels } from "./models";

export type File =
  | { name: string; text: string }
  | { name: string; base64: string }
  | { name: string; path: string }
  | { name: string; lines: { before: string; line: string; count: number; after: string } };

export interface Read {
  answer: { check: string; verdict: string | null }[];
  document: { verdict: string; reason: string | null };
}

export interface Row {
  /** The model's reply to the sentence in both checks; supported when absent. */
  verdict?: "contradicted";
  id: string;
  source: string;
  language: "en" | "zh-CN";
  sentence: string;
  quotes: string[];
  files: string[];
  main: Read;
  here: Read;
}

const ROOT = join(__dirname, "../..");

export const TABLE = JSON.parse(
  readFileSync(join(ROOT, "tests/fixtures/answerUnits/table.json"), "utf8"),
) as { files: Record<string, File>; rows: Row[] };

function contents(file: File): string | Uint8Array {
  if ("text" in file) return file.text;
  if ("base64" in file) return new Uint8Array(Buffer.from(file.base64, "base64"));
  if ("path" in file) return new Uint8Array(readFileSync(join(ROOT, file.path)));
  const { before, line, count, after } = file.lines;
  const lines = Array.from({ length: count }, (_, at) => line.replace("{n}", String(at)));
  return `${before}${lines.join("\n")}\n${after}`;
}

const loose = (text: string) => text.replace(/\s+/gu, " ").trim();

const marked = (sentence: string, count: number) => {
  const markers = Array.from({ length: count }, (_, at) => `[^${at + 1}]`).join("");
  const end = /[.。!?！？]$/u.exec(sentence);
  return end ? `${sentence.slice(0, -1)}${markers}${end[0]}` : `${sentence}${markers}`;
};

/** The table's parts, each run by its own test file, by the test or set a row comes from. */
export const PARTS = {
  currencies: ["figureCurrencies"],
  units: ["figureUnits"],
  labels: ["labels"],
  edges: ["issue", "edge"],
  points: ["points"],
  headings: ["heading"],
} as const;

export const rowsOf = (part: keyof typeof PARTS) =>
  TABLE.rows.filter((row) =>
    (PARTS[part] as readonly string[]).includes(row.source.split(" › ")[0] ?? ""),
  );

/** Whether a read shows the Answer's ✓: every Citation of its sentence found. */
export const shows = (read: Read) =>
  read.answer.length > 0 && read.answer.every(({ check }) => check === "found");

/** Runs `rows` in order, each against what was measured, stopping at the first that reads otherwise. */
export const readsAsMeasured = (rows: readonly Row[]) =>
  readRows(rows, (row, read) =>
    expect(read, `${row.id} (${row.source}): ${row.sentence}`).toEqual(row.here),
  );

type Asked = Pick<Row, "verdict" | "id" | "language" | "sentence" | "quotes" | "files">;

/**
 * Runs `rows` in order in one core holding every file they cite (from `files`, by key), handing
 * each row's read to `onRead` as it is read.
 */
export async function readRows<Each extends Asked>(
  rows: readonly Each[],
  onRead: (row: Each, read: Read) => void,
  files: Record<string, File> = TABLE.files,
): Promise<void> {
  const keys = [...new Set(rows.flatMap((row) => row.files))];
  let row: Each | undefined;
  const plansOf = (each: Asked): Record<string, Plan> => ({
    [each.sentence]: {
      verdict: each.verdict ?? "supported",
      quote: each.quotes[0],
      says: each.quotes[0],
      judgement: "conflict",
    },
  });
  const names = (each: Asked) => each.files.map((key) => files[key]?.name ?? "");
  const citing = (call: ModelCall, each: Asked): ScriptedReply => {
    const searches = call.results.filter((result) => result.tool === "search_documents");
    if (searches.length === 0)
      return {
        calls: [{ tool: "search_documents", input: { query: loose(each.quotes.join(" ")) } }],
      };
    if (!call.results.some((result) => result.tool === "cite")) {
      const shown = searches.flatMap((result) => shownPassages(result.text));
      const citations = each.quotes.map((quote, at) => ({
        marker: at + 1,
        passage: (
          shown.find((passage) => loose(passage.text).includes(loose(quote))) ??
          shown.find((passage) => passage.document === names(each)[at]?.replace(/\.\w+$/u, "")) ??
          shown[0]
        )?.id,
        quote,
      }));
      return { calls: [{ tool: "cite", input: { citations } }] };
    }
    return { text: marked(each.sentence, each.quotes.length) };
  };
  const batch = (prompt: string, verdict: string) =>
    JSON.stringify({
      sentences: [...prompt.matchAll(/<sentence number="(\d+)">/g)].map(([, number]) => ({
        number: Number(number),
        kind: "fact",
        verdict,
        roles: "same",
        time: "same",
        quoted: "states",
        says: "The Document says so.",
      })),
    });
  const model = scriptedModel(
    (call) => {
      if (!row) throw new Error("No row is being read.");
      return isCheckRun(call) ? checkReply(call, plansOf(row)) : citing(call, row);
    },
    {
      generate: (call) => {
        if (!row) throw new Error("No row is being read.");
        return call.question === "sentence-batch"
          ? { text: batch(call.prompt, row.verdict ?? "supported") }
          : checkGenerate(plansOf(row))(call);
      },
    },
  );
  const core = startCore(await createTempDataFolder(), {
    createChatModel: scriptedModels(model).createChatModel,
  });
  await core.saveChatProvider({ kind: "ollama", modelId: "local-model" });
  const sources = await realpath(await createTempDataFolder());
  // Rows share names ("Cited 1.txt") with other words: each file keeps its name in its own folder.
  const paths = await Promise.all(
    keys.map((key) => {
      const file = files[key];
      if (!file) throw new Error(`No file ${key}.`);
      return writeSourceFile(join(sources, key), file.name, contents(file));
    }),
  );
  const documents = await addAndProcess(core, paths, 120_000);
  const idOf = new Map(keys.map((key, at) => [key, documentAt(documents, paths[at] ?? "").id]));
  let language = "en";
  try {
    for (row of rows) {
      const documentIds = row.files.map((key) => idOf.get(key) ?? "");
      const scope = { folderIds: [], tagIds: [], documentIds };
      if (row.language !== language) {
        language = row.language;
        await core.updateSettings({ user: { language: row.language } });
      }
      const asked = await core.askInConversation({ text: "What does it say?", scope });
      if (!asked.asked) throw new Error(`${row.id} wasn't asked.`);
      await answerEnded(core, asked.answerId);
      const judged = await answerJudged(core, asked.conversation.id, asked.answerId);
      // A check whose own search finds nothing is shown the sentence's quotes, as a Note's check is.
      const alone = await core.checkClaim({ claim: row.sentence, scope });
      const fileNames = names(row);
      const checked =
        alone.verdict === "not-checked" && alone.reason === "no-evidence"
          ? await core.checkClaim({
              claim: row.sentence,
              scope,
              cited: row.quotes.map((quote, at) => ({
                documentName: (fileNames[at] ?? fileNames[0] ?? "").replace(/\.\w+$/u, ""),
                quote,
              })),
            })
          : alone;
      const read: Read = {
        answer: judged.citations.map(({ check, verdict }) => ({ check, verdict: verdict ?? null })),
        document: {
          verdict: checked.verdict,
          reason:
            checked.verdict === "unsupported"
              ? (checked.unsupported?.reason ?? null)
              : checked.verdict === "not-checked"
                ? checked.reason
                : null,
        },
      };
      onRead(row, read);
    }
  } finally {
    core.close();
  }
}
