import { translateNow } from "../i18n";

export const checklistLabel = (text: string): string =>
  text.trim() || translateNow("editor.checklist.empty");
