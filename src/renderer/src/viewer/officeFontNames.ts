/**
 * The viewer's own names for Office's fonts (ADR-0011, `officeFonts.css`). An @font-face
 * named "Segoe UI" is registered for the whole app once the viewer loads, and Chromium then
 * draws every "Segoe UI" the app names with only the faces declared here: weights 500 and 600
 * become 400 or 700, and on a computer without the font every character becomes Carlito. The
 * prefix keeps these faces to the documents that ask for them, through `officeFontName`.
 */
const PREFIX = "IncarnaMind Office";

const SUBSTITUTES: Readonly<Record<string, string>> = {
  calibri: `${PREFIX} Calibri`,
  "calibri light": `${PREFIX} Calibri Light`,
  cambria: `${PREFIX} Cambria`,
  aptos: `${PREFIX} Aptos`,
  "aptos display": `${PREFIX} Aptos Display`,
  "aptos narrow": `${PREFIX} Aptos Narrow`,
  "segoe ui": `${PREFIX} Segoe UI`,
};

/** A Document's font name as the viewer's face for it; any other name is its own. */
export function officeFontName(name: string): string {
  return SUBSTITUTES[name.trim().toLowerCase()] ?? name;
}

/** A font-family list with each Office name swapped for the viewer's face, quoted again. */
export function officeFontFamilyList(value: string): string {
  return value
    .split(",")
    .map((part) => {
      const name = part.trim().replaceAll(/^["']|["']$/g, "");
      if (name === "") return part.trim();
      const mapped = officeFontName(name);
      return mapped === name ? part.trim() : `"${mapped}"`;
    })
    .join(", ");
}

/** docx-preview's sheet and the document's own inline styles, with Office's names mapped. */
export function mapOfficeFontNames(styles: HTMLElement, body: HTMLElement): void {
  for (const sheet of styles.querySelectorAll("style")) {
    sheet.textContent = (sheet.textContent ?? "").replaceAll(
      /font-family\s*:\s*([^;}]+)/gi,
      (whole, value: string) => {
        const mapped = officeFontFamilyList(value);
        return mapped === value.trim() ? whole : `font-family: ${mapped}`;
      },
    );
  }
  for (const element of [body, ...body.querySelectorAll<HTMLElement>("[style]")]) {
    const family = element.style.fontFamily;
    if (family !== "") element.style.fontFamily = officeFontFamilyList(family);
  }
}
