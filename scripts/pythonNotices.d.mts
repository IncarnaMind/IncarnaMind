export const NATIVE_CODE: { path: RegExp; notices: string[] }[];
export function noticesFor(wheel: string, path: string): string[] | null;
export function zipNames(file: string): string[];
export function hasEntry(notice: string, name: string): boolean;
