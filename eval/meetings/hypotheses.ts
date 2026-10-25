import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Hypothesis } from "./types";

/** A case's hypothesis in a results folder; null when the folder has none, an error when the file is no hypothesis. */
export async function readHypothesis(folder: string, id: string): Promise<Hypothesis | null> {
  const path = join(folder, `${id}.json`);
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  let hypothesis: Hypothesis;
  try {
    hypothesis = JSON.parse(text) as Hypothesis;
  } catch (error) {
    throw new Error(
      `${path} isn't JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (hypothesis.case !== id || !Array.isArray(hypothesis.segments)) {
    throw new Error(
      `${path} isn't a hypothesis for ${id}: it needs "case": "${id}" and "segments".`,
    );
  }
  return hypothesis;
}
