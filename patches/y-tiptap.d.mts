export const VERSION: string;
export function libraryUpdateYText(diff: string): string;
export function patchedUpdateYText(diff: string, helpers: string): string;
export function helpersOf(source: string): string;
export function patchBuild(
  text: string,
  helpers: string,
): { status: "already" | "patched"; text: string };
