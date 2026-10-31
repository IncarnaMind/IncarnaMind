import { describe, expect, test, vi } from "vitest";
import * as Y from "yjs";
import {
  CHART_NODE,
  CONTENT_SCHEMA_VERSION,
  CONTENT_SCHEMA_VERSION_KEY,
  MIND_CONTENT_FIELD,
  MIND_SETTINGS_FIELD,
  MindReadOnlyError,
} from "../../src/core";
import { chartOf, TABLE } from "../helpers/calculatedCharts";
import { createTempDataFolder, startCore } from "../helpers/core";

/*
 * The version before a chart's values kept their calculated figures (#2307): its core is this
 * one with the newest content schema it understands set back to 42.
 */
vi.mock("../../src/core/api", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  CONTENT_SCHEMA_VERSION: 42,
}));

/** The content schema version chart figures came with: what a Note written since records. */
const FIGURES = 43;

/** The chart's data as this version writes it, its calculated values with their figures. */
const DATA = JSON.parse(JSON.stringify(chartOf(TABLE).data));

/** The same data as the version before reads it and writes it back: every figure gone. */
const STRIPPED = JSON.parse(
  JSON.stringify(DATA, (key, value) => (key === "figure" ? undefined : value)),
);

function noteWithChart(): Y.Doc {
  const doc = new Y.Doc();
  const chart = new Y.XmlElement(CHART_NODE);
  chart.setAttribute("id", "chart-1");
  chart.setAttribute("kind", "bar");
  chart.setAttribute("title", "Total revenue by region");
  chart.setAttribute("data", DATA as unknown as string);
  doc.getXmlFragment(MIND_CONTENT_FIELD).push([chart]);
  doc.getMap(MIND_SETTINGS_FIELD).set(CONTENT_SCHEMA_VERSION_KEY, FIGURES);
  return doc;
}

const chartData = (doc: Y.Doc) => {
  const chart = doc.getXmlFragment(MIND_CONTENT_FIELD).get(0);
  return chart instanceof Y.XmlElement ? (chart.getAttribute("data") as unknown) : null;
};

describe("a version from before chart figures", () => {
  test("opens a Note whose chart keeps its calculated figures read-only, so its write can't drop them", async () => {
    expect(CONTENT_SCHEMA_VERSION).toBe(42);
    expect(JSON.stringify(DATA)).toContain('"figure"');
    expect(JSON.stringify(STRIPPED)).not.toContain('"figure"');
    const core = startCore(await createTempDataFolder());
    const mind = await core.createMind({ title: "Regions" });
    await core.applyMindUpdate(mind.id, Y.encodeStateAsUpdate(noteWithChart()));

    const opened = await core.openMind(mind.id);
    expect(opened.access).toBe("read-only");
    const doc = new Y.Doc();
    Y.applyUpdate(doc, opened.state);
    expect(chartData(doc)).toEqual(DATA);

    // Its editor writes the chart's values back as it reads them, without their figures: refused.
    const sent: Uint8Array[] = [];
    doc.on("update", (update: Uint8Array) => sent.push(update));
    const chart = doc.getXmlFragment(MIND_CONTENT_FIELD).get(0);
    if (!(chart instanceof Y.XmlElement)) throw new Error("No chart.");
    chart.setAttribute("data", STRIPPED as unknown as string);
    await expect(core.applyMindUpdate(mind.id, sent[0] as Uint8Array)).rejects.toThrow(
      MindReadOnlyError,
    );
    const again = new Y.Doc();
    Y.applyUpdate(again, (await core.openMind(mind.id)).state);
    expect(chartData(again)).toEqual(DATA);
    core.close();
  });
});
