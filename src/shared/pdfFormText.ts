import type { PDFPageProxy, TextContent, TextItem } from "pdfjs-dist/types/src/display/api";
import { isRecord } from "../core/errors";

export const PDF_UNREAD_FIELD = "[?]";
export const PDF_BLANK_FIELD = '""';

const FORM_FONT = "incarnamindForm";
const INVISIBLE = 1;
const HIDDEN = 2;
const NO_VIEW = 32;
const strings = (value: unknown): string[] | null =>
  typeof value === "string"
    ? [value]
    : Array.isArray(value) && value.every((part: unknown) => typeof part === "string")
      ? value
      : null;

function numbers(value: unknown, length: number): number[] | null {
  if (!Array.isArray(value) || value.length !== length) return null;
  const result: number[] = [];
  for (const part of value) {
    if (typeof part !== "number" || !Number.isFinite(part)) return null;
    result.push(part);
  }
  return result;
}

function fieldValue(field: Record<string, unknown>): string | null {
  if (field.fieldType === "Btn") {
    const selected = field.radioButton === true ? field.buttonValue : field.exportValue;
    if (typeof selected !== "string" || typeof field.fieldValue !== "string") return null;
    return field.fieldValue === selected ? "[x]" : "[ ]";
  }
  if (field.fieldType !== "Tx" && field.fieldType !== "Ch") return null;
  const visible = field.fieldType === "Tx" ? strings(field.textContent) : null;
  if (visible && visible.length > 0) return visible.join("\n");
  const values = strings(field.fieldValue);
  if (!values)
    return field.fieldValue == null && field.hasAppearance !== true ? PDF_BLANK_FIELD : null;
  if (values.length === 0 || values.every((value) => value === "")) return PDF_BLANK_FIELD;
  const options = Array.isArray(field.options) ? field.options.filter(isRecord) : [];
  return values
    .map((value) => {
      const option = options.find((option) => option.exportValue === value);
      return typeof option?.displayValue === "string" ? option.displayValue : value;
    })
    .join("; ");
}

function fieldLabel(
  field: Record<string, unknown>,
  rect: number[],
  items: TextContent["items"],
): string {
  if (typeof field.alternativeText === "string" && field.alternativeText.trim()) {
    return field.alternativeText.trim();
  }
  const [left = 0, bottom = 0, right = 0, top = 0] = rect;
  const candidates = items.flatMap((item) => {
    if (!("str" in item) || !item.str.trim()) return [];
    const x = Number(item.transform[4]);
    const y = Number(item.transform[5]);
    const horizontal = x < left ? left - (x + item.width) : x - right;
    const distance = Math.abs(y - (bottom + top) / 2) + Math.max(0, horizontal) / 4;
    if (
      y < bottom - item.height ||
      y > top + item.height * 2 ||
      (x >= left && x <= right && y >= bottom && y <= top)
    )
      return [];
    return [{ text: item.str, distance, x, y, height: item.height, right: x + item.width }];
  });
  const nearest = candidates.sort((a, b) => a.distance - b.distance)[0];
  if (nearest) {
    const row = candidates
      .filter((item) => Math.abs(item.y - nearest.y) <= Math.max(1, nearest.height / 2))
      .sort((a, b) => a.x - b.x);
    let start = row.indexOf(nearest);
    let end = start;
    while (start > 0 && (row[start]?.x ?? 0) - (row[start - 1]?.right ?? 0) < nearest.height * 2)
      start--;
    while (
      end + 1 < row.length &&
      (row[end + 1]?.x ?? 0) - (row[end]?.right ?? 0) < nearest.height * 2
    )
      end++;
    return row
      .slice(start, end + 1)
      .map((item) => item.text)
      .join(" ")
      .trim();
  }
  return typeof field.fieldName === "string" ? field.fieldName.trim() : "";
}

export function pdfFormText(
  content: TextContent,
  annotations: readonly unknown[],
  view?: readonly number[],
) {
  const items: TextItem[] = [];
  let unread = false;
  for (const field of annotations) {
    if (
      !isRecord(field) ||
      field.subtype !== "Widget" ||
      field.hidden === true ||
      (typeof field.annotationFlags === "number" &&
        (field.annotationFlags & (INVISIBLE | HIDDEN | NO_VIEW)) !== 0) ||
      field.pushButton === true
    )
      continue;
    const rect = numbers(field.rect, 4);
    if (!rect) {
      unread = true;
      continue;
    }
    const [left = 0, bottom = 0, right = 0, top = 0] = rect;
    if (
      right <= left ||
      top <= bottom ||
      (view &&
        (right <= (view[0] ?? 0) ||
          top <= (view[1] ?? 0) ||
          left >= (view[2] ?? 0) ||
          bottom >= (view[3] ?? 0)))
    )
      continue;
    if (field.password === true) {
      unread = true;
      continue;
    }
    const label = fieldLabel(field, rect, content.items);
    const value = fieldValue(field);
    unread ||= value === null || label === "";
    if (value === null && !label) continue;
    const appearance = isRecord(field.defaultAppearanceData) ? field.defaultAppearanceData : null;
    const fontSize =
      typeof appearance?.fontSize === "number" && appearance.fontSize > 0
        ? appearance.fontSize
        : 12;
    const height = Math.max(1, Math.min(fontSize, top - bottom));
    const position = numbers(field.textPosition, 2);
    const x = left + (position?.[0] ?? 0);
    const baseline = bottom + (position?.[1] ?? height * 0.8);
    items.push({
      str: `${label ? `${label}: ` : ""}${value ?? PDF_UNREAD_FIELD}`,
      dir: "ltr",
      transform: [height, 0, 0, height, x, baseline],
      width: Math.max(1, right - x),
      height,
      fontName: FORM_FONT,
      hasEOL: true,
    });
  }
  const pageItems = [...content.items];
  const last = pageItems.findLastIndex((item) => "str" in item);
  const lastItem = pageItems[last];
  if (items.length > 0 && lastItem && "str" in lastItem) {
    pageItems[last] = { ...lastItem, hasEOL: true };
  }
  return {
    content:
      items.length === 0
        ? content
        : {
            ...content,
            items: [...pageItems, ...items],
            styles: {
              ...content.styles,
              [FORM_FONT]: {
                fontFamily: "sans-serif",
                ascent: 0.8,
                descent: -0.2,
                vertical: false,
              },
            },
          },
    fields: items,
    source: content,
    unread,
  };
}

export async function readPdfPageText(page: PDFPageProxy) {
  const content = await page.getTextContent();
  return pdfFormText(content, await page.getAnnotations(), page.view);
}
