/**
 * Models recommended for Ollama, by this computer's memory. Ollama reports a
 * pulled model's capabilities and context, but not before it is pulled, and
 * not its size reliably (an MLX build's `parameter_size` can be wrong): these
 * are the facts for choosing what to download. Sizes are the downloads in
 * Ollama's registry; each pick keeps the model's weights and its context
 * within half of the memory, as `chooseNumCtx` in ../ollamaModels does.
 *
 * "Tested with IncarnaMind" belongs only to a model with `evaluated`: so far
 * qwen3.5:4b (#67). Refreshed by hand.
 */
import type { LocalModel } from "./types";

export const LOCAL_MODELS: readonly LocalModel[] = [
  {
    name: "Qwen 3.5 2B",
    tag: "qwen3.5:2b",
    parameters: 1.9,
    download: { gguf: 2.68, mlx: 3.12 },
    context: 262_144,
    capabilities: ["tools", "thinking", "vision"],
    languages: ["en", "zh"],
    licence: "Apache-2.0",
  },
  {
    name: "Qwen 3.5 4B",
    tag: "qwen3.5:4b",
    parameters: 4.2,
    download: { gguf: 3.32, mlx: 3.97 },
    context: 262_144,
    capabilities: ["tools", "thinking", "vision"],
    languages: ["en", "zh"],
    licence: "Apache-2.0",
    evaluated: "#67, 2026-10-10",
  },
  {
    name: "Qwen 3.5 9B",
    tag: "qwen3.5:9b",
    parameters: 9,
    download: { gguf: 6.55, mlx: 7.64 },
    context: 262_144,
    capabilities: ["tools", "thinking", "vision"],
    languages: ["en", "zh"],
    licence: "Apache-2.0",
  },
  {
    name: "Gemma 4 12B",
    tag: "gemma4:12b",
    parameters: 11.9,
    download: { gguf: 8.02, mlx: 7.71 },
    context: 262_144,
    capabilities: ["tools", "thinking", "vision", "audio"],
    languages: ["en"],
    licence: "Apache-2.0",
  },
  {
    name: "Gemma 4 26B A4B",
    tag: "gemma4:26b-a4b",
    parameters: 25.2,
    activeParameters: 3.8,
    download: { gguf: 18.73, mlx: 16.15 },
    context: 262_144,
    capabilities: ["tools", "thinking", "vision"],
    languages: ["en", "zh"],
    licence: "Apache-2.0",
  },
  {
    name: "Qwen 3.6 35B A3B",
    tag: "qwen3.6:35b-a3b",
    parameters: 35,
    activeParameters: 3,
    download: { gguf: 22.62, mlx: 23.6 },
    context: 262_144,
    capabilities: ["tools", "thinking", "vision"],
    languages: ["en", "zh"],
    licence: "Apache-2.0",
  },
  {
    name: "Qwen 3.8 27B",
    tag: "qwen3.8:27b",
    parameters: 27.3,
    download: { gguf: 17.74, mlx: 18.17 },
    context: 262_144,
    capabilities: ["tools", "thinking", "vision"],
    languages: ["en", "zh"],
    licence: "Apache-2.0",
  },
  {
    name: "Gemma 4 31B",
    tag: "gemma4:31b",
    parameters: 30.7,
    download: { gguf: 20.39, mlx: 19.42 },
    context: 262_144,
    capabilities: ["tools", "thinking", "vision"],
    languages: ["en"],
    licence: "Apache-2.0",
  },
  {
    name: "GLM 4.7 Flash",
    tag: "glm-4.7-flash",
    parameters: 29.9,
    download: { gguf: 19.02 },
    context: 202_752,
    capabilities: ["tools", "thinking"],
    languages: ["en", "zh"],
    licence: "MIT",
  },
];

/**
 * What each size of memory is offered, the default first, in GB: the
 * largest tier at or below this computer's memory applies, and the smallest
 * below 8 GB.
 */
export const LOCAL_MODEL_TIERS: readonly { memoryGb: number; models: readonly string[] }[] = [
  { memoryGb: 8, models: ["qwen3.5:4b", "qwen3.5:2b"] },
  { memoryGb: 16, models: ["qwen3.5:4b", "qwen3.5:9b", "gemma4:12b"] },
  // qwen3.5:9b leads from 32 GB; the 27B models don't fit once MLX's prefix cache is counted.
  { memoryGb: 32, models: ["qwen3.5:9b", "qwen3.5:4b", "gemma4:26b-a4b"] },
  {
    memoryGb: 64,
    models: ["qwen3.6:35b-a3b", "qwen3.8:27b", "gemma4:31b", "glm-4.7-flash"],
  },
];

const GIB = 1024 ** 3;

/** The models recommended for a computer with this much memory, the default first. */
export function recommendedLocalModels(memoryBytes: number): LocalModel[] {
  // A "16 GB" computer reports 16 GiB; a little less still counts, as the OS reserves some.
  const gb = Math.round(memoryBytes / GIB);
  const tier =
    [...LOCAL_MODEL_TIERS].reverse().find((each) => each.memoryGb <= gb) ?? LOCAL_MODEL_TIERS[0];
  return (tier?.models ?? []).flatMap((tag) => LOCAL_MODELS.filter((each) => each.tag === tag));
}
