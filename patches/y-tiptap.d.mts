export interface Parts {
  format: string;
  attributesToMarks: string;
  marksToAttributes: string;
}
export const VERSION: string;
export const LIBRARY_ATTRIBUTES_TO_MARKS: string;
export function libraryUpdateYText(diff: string): string;
export function patchedUpdateYText(diff: string, helpers: string): string;
export function libraryMarksToAttributes(map: string): string;
export function helpersOf(source: string): string;
export function partsOf(formatSource: string, marksSource: string): Parts;
export function replacementsOf(
  parts: Parts,
): { name: string; issue: string; variants: { library: string; ours: string }[] }[];
export function patchBuild(
  text: string,
  parts: Parts,
): { status: "already" | "patched"; text: string };
