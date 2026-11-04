export const AUDITED_WHEELS: Record<string, string[]>;
export const AUDITED_FONTS: Record<string, string[]>;
export const REQUIRED_TEXT: Record<string, string[] | null>;
export function noticeProblems(
  notice: string,
  packages: readonly { name: string; version: string }[],
  fonts: readonly string[],
): string[];
