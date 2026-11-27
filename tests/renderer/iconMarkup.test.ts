import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import {
  ChatLineIcon,
  type Icon,
  iconMarkup,
  LockLineIcon,
  NoteLineIcon,
  SparkLineIcon,
  type WidgetIcon,
} from "../../src/renderer/src/components/icons";

/** The drawing alone: each element's name and attributes but the class, which Lucide's component adds to. */
const shapes = (markup: string) =>
  [...markup.matchAll(/<(\w+)([^>]*)>/g)].map(([, tag, attributes]) => [
    tag,
    (attributes ?? "").replace(/ class="[^"]*"/, "").trim(),
  ]);

describe("an icon a widget draws outside React", () => {
  const widgets: [WidgetIcon, Icon][] = [
    ["chat", ChatLineIcon],
    ["lock", LockLineIcon],
    ["note", NoteLineIcon],
    ["spark", SparkLineIcon],
  ];
  test.each(widgets)("%s is the same drawing as its component's, an app icon", (name, Glyph) => {
    const markup = iconMarkup(name, "proposals-bar-icon");
    expect(shapes(markup)).toEqual(shapes(renderToStaticMarkup(createElement(Glyph))));
    expect(markup).toMatch(/^<svg [^>]*class="app-icon proposals-bar-icon"/);
    expect(markup).toContain('aria-hidden="true"');
  });
});
