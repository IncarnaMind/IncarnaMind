/**
 * `run_code`'s Python as it downloads the first time code needs it (ADR-0025): the step of the
 * call that waits on it says how far it has come, where the User asked.
 */
import { create } from "zustand";
import type { EmbeddingModelStatus } from "../../core/api";
import { core } from "./core";

export const usePythonRuntime = create<{ status: EmbeddingModelStatus | null }>(() => ({
  status: null,
}));

core.on("pythonRuntime.status", (status) => usePythonRuntime.setState({ status }));
