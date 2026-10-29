import { mergeAttributes, Node, type NodeViewRenderer } from "@tiptap/core";
import { CHART_NODE } from "../../../core/api";
import { CHART_KINDS, chosenSeries, readChart } from "../../../shared/charts";
import { citationReference } from "../../../shared/citations";

export interface ChartOptions {
  view: NodeViewRenderer | null;
}

/** Kept in the HTML, so a chart copied into a Note or another Mind keeps everything it holds. */
function jsonAttribute(name: string) {
  return {
    default: null,
    parseHTML: (element: HTMLElement) => {
      const raw = element.getAttribute(`data-${name}`);
      if (raw === null) return null;
      try {
        return JSON.parse(raw) as unknown;
      } catch {
        return null;
      }
    },
    renderHTML: (attributes: Record<string, unknown>) =>
      attributes[name] === null || attributes[name] === undefined
        ? {}
        : { [`data-${name}`]: JSON.stringify(attributes[name]) },
  };
}

function chartText(attributes: Record<string, unknown>): string {
  const chart = readChart(attributes);
  const drawn = chosenSeries(chart);
  const lines = [
    chart.title,
    [chart.data.labelHeading, ...drawn.map((series) => chart.data.series[series] ?? "")].join("\t"),
    ...chart.data.rows.map((row) =>
      [
        row.label,
        ...drawn.map((series) => {
          const value = row.values[series];
          if (!value) return "";
          const source = value.citation ? citationReference(value.citation) : "";
          return source ? `${value.shown} ${source}` : value.shown;
        }),
      ].join("\t"),
    ),
  ];
  return lines.filter((line) => line.trim() !== "").join("\n");
}

/** A chart (#436); as HTML for another app, its title and a table of its values. */
export const Chart = Node.create<ChartOptions>({
  name: CHART_NODE,
  group: "block",
  atom: true,
  selectable: true,
  draggable: false,

  addOptions() {
    return { view: null };
  },

  addAttributes() {
    return {
      kind: {
        default: "bar",
        parseHTML: (element: HTMLElement) => {
          const kind = element.getAttribute("data-kind");
          return kind && (CHART_KINDS as readonly string[]).includes(kind) ? kind : "bar";
        },
        renderHTML: (attributes: Record<string, unknown>) => ({ "data-kind": attributes.kind }),
      },
      title: {
        default: "",
        parseHTML: (element: HTMLElement) => element.getAttribute("data-title") ?? "",
        renderHTML: (attributes: Record<string, unknown>) =>
          attributes.title ? { "data-title": attributes.title } : {},
      },
      drawn: jsonAttribute("drawn"),
      data: jsonAttribute("data"),
      source: jsonAttribute("source"),
      claimCheck: { default: null, rendered: false, parseHTML: () => null },
    };
  },

  parseHTML() {
    return [{ tag: `div[data-type="${CHART_NODE}"]` }];
  },

  renderHTML({ node, HTMLAttributes }) {
    const chart = readChart(node.attrs);
    const drawn = chosenSeries(chart);
    const cell = (tag: "th" | "td", text: string) => [tag, {}, text] as const;
    return [
      "div",
      mergeAttributes(HTMLAttributes, { "data-type": CHART_NODE }),
      ...(chart.title ? [["p", {}, chart.title]] : []),
      [
        "table",
        {},
        [
          "tr",
          {},
          cell("th", chart.data.labelHeading),
          ...drawn.map((series) => cell("th", chart.data.series[series] ?? "")),
        ],
        ...chart.data.rows.map((row) => [
          "tr",
          {},
          cell("td", row.label),
          ...drawn.map((series) => cell("td", row.values[series]?.shown ?? "")),
        ]),
      ],
    ];
  },

  renderText({ node }) {
    return chartText(node.attrs);
  },

  addNodeView() {
    return this.options.view;
  },
});
