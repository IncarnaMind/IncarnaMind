import { XMLSerializer, DOMParser as XmlParser } from "@xmldom/xmldom";
import { parseHTML } from "linkedom";
import { vi } from "vitest";

/** Reads a Word file's XML with xmldom, which keeps the names' prefixes apart as docx-preview expects. */
class WordXml {
  parseFromString(text: string, type: string) {
    const document = new XmlParser().parseFromString(text, type);
    // docx-preview finds a part's root by `firstElementChild`, which xmldom's documents don't have.
    Object.defineProperty(document, "firstElementChild", { value: document.documentElement });
    return document;
  }
}

/**
 * A DOM docx-preview can draw a Word file into in plain Node: its XML read by xmldom, its pages
 * held by linkedom. Nothing is laid out, so a page's size is what its style says. `unmount` takes
 * the globals it stubbed away again.
 */
export function mountWordDom(): { body: HTMLElement; styles: HTMLElement; unmount(): void } {
  const { window, document } = parseHTML("<!doctype html><html><body></body></html>");
  vi.stubGlobal("window", window);
  vi.stubGlobal("document", document);
  vi.stubGlobal("Node", window.Node);
  vi.stubGlobal("DOMParser", WordXml);
  vi.stubGlobal("XMLSerializer", XMLSerializer);
  const body = document.createElement("div");
  const styles = document.createElement("div");
  document.body.append(body, styles);
  return { body, styles, unmount: () => vi.unstubAllGlobals() };
}
