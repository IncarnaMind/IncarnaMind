import type { RecordCiteResult } from "../api";
import type { RecordItem } from "./read";

const CHECK = '<path d="m5 12.5 4.5 4.5L19 7.5"/>';
const BANG = '<path d="M12 6v8M12 18.5v.01"/>';

// The marks' shapes (see icons.tsx) in black, so a result is never told by colour alone; a plus
// tells "supported" from "quote found".
type Result = RecordItem["result"] | RecordCiteResult["outcome"];

const SHAPES: Readonly<Record<Result, string>> = {
  found: CHECK,
  supported: `${CHECK}<path d="M26 6v8M22 10h8"/>`,
  partly: `${CHECK}<path d="M22 10h8"/>`,
  choose: '<circle cx="12" cy="12" r="6.5"/>',
  unsupported: BANG,
  notFound: BANG,
  "not-found": BANG,
  contradicted: '<path d="M6 9.5h12M6 14.5h12M15 5l-6 14"/>',
  "cant-check": '<path d="M7 12h10"/>',
  notChecked: '<circle cx="12" cy="12" r="6.5"/>',
  needsRecheck: '<path d="M18.5 12a6.5 6.5 0 1 1-1.9-4.6M17.5 3.5v4h-4"/>',
  changed: '<path d="M18.5 12a6.5 6.5 0 1 1-1.9-4.6M17.5 3.5v4h-4"/>',
  checking: '<circle cx="12" cy="12" r="4" fill="#000"/>',
};

export const shapeOf = (result: Result): string =>
  `<svg viewBox="0 0 32 24" width="17" height="13" fill="none" stroke="#000" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${SHAPES[result]}</svg>`;
