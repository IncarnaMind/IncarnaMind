/**
 * Measure 4: Chinese typed through an input method, driven over the Chrome
 * DevTools Protocol (a composition, then its commit), into twelve text boxes
 * of the test deck at four places each: a paragraph's start, inside its first
 * run, at the edge before its bold run, and its end. Each composition is
 * checked in the deck the arm would save: the words once, in the right place,
 * and every run's formatting kept. While it composes, nothing may redraw the box.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "@playwright/test";
import { child, elements, local, parseXml } from "../../../src/core/documents/formats/xml";
import { openPackage } from "../../../src/core/documents/formats/zip";
import { shapeById } from "../../../src/core/exports/pptxPatch/shapes";
import { type Arm, armA, armB } from "./arms";
import { lane } from "./bench";

interface RunText {
  text: string;
  properties: string;
}

async function runsOf(bytes: Uint8Array, slide: number, shapeId: string): Promise<RunText[]> {
  const xml = (await openPackage(bytes).readText(`ppt/slides/slide${slide}.xml`)) ?? "";
  const shape = shapeById(parseXml(xml), shapeId);
  const body = shape && child(shape, "txBody");
  const paragraph = body && elements(body).find((each) => local(each.name) === "p");
  if (!paragraph) return [];
  return elements(paragraph)
    .filter((each) => local(each.name) === "r")
    .map((run) => {
      const rPr = child(run, "rPr");
      const t = child(run, "t");
      return {
        text: t ? t.children.filter((each) => typeof each === "string").join("") : "",
        properties: rPr ? JSON.stringify(rPr.attrs) : "",
      };
    });
}

const PLACES = [
  { name: "end", word: "庚辛" },
  { name: "bold edge", word: "戊己" },
  { name: "inside", word: "丙丁" },
  { name: "start", word: "甲乙" },
] as const;

async function measure(arm: Arm) {
  const deck = join(lane, "decks/test-deck.pptx");
  await arm.open(deck, 2);
  const cdp = await arm.window.context().newCDPSession(arm.window);
  const results: Record<string, unknown>[] = [];
  for (const slide of [2, 3, 4]) {
    await arm.goTo(slide);
    for (const shapeId of ["10", "11", "12", "13"]) {
      const original = await runsOf(await arm.bytes(), slide, shapeId);
      let expected = original.map((run) => run.text).join("");
      const first = original[0]?.text.length ?? 0;
      for (const place of PLACES) {
        const offset =
          place.name === "end"
            ? expected.length
            : place.name === "bold edge"
              ? first
              : place.name === "inside"
                ? Math.floor(first / 2)
                : 0;
        const shape = await arm.shape(shapeId);
        const box = await shape.boundingBox();
        if (!box) throw new Error("shape not on screen");
        await arm.window.mouse.dblclick(box.x + 8, box.y + box.height / 2);
        await arm.window.waitForFunction(() => {
          let element: Element | null = document.activeElement;
          while (element?.shadowRoot?.activeElement) element = element.shadowRoot.activeElement;
          return element instanceof HTMLElement && element.isContentEditable;
        });
        await arm.window.keyboard.press("Meta+ArrowLeft");
        for (let step = 0; step < offset; step++) await arm.window.keyboard.press("ArrowRight");
        // Watch the box while it composes: redraws (React's commits for A) and DOM changes other than text.
        await arm.window.evaluate(() => {
          let element: Element | null = document.activeElement;
          while (element?.shadowRoot?.activeElement) element = element.shadowRoot.activeElement;
          const watched = {
            structural: 0,
            composing: false,
            commits: 0,
            events: [] as string[],
            kinds: [] as string[],
          };
          const observer = new MutationObserver((records) => {
            for (const record of records) {
              if (!watched.composing || record.type === "characterData") continue;
              watched.structural++;
              const target =
                record.target instanceof Element ? record.target.tagName : record.target.nodeName;
              watched.kinds.push(
                `${record.type}:${record.attributeName ?? ""}:${target}:+${record.addedNodes.length}-${record.removedNodes.length}`,
              );
            }
          });
          if (element) {
            observer.observe(element, {
              subtree: true,
              childList: true,
              attributes: true,
              characterData: true,
            });
            element.addEventListener("compositionstart", () => {
              watched.composing = true;
              watched.events.push("start");
              const bench = (window as unknown as { benchA?: { state: { commits: number[] } } })
                .benchA;
              watched.commits = bench ? bench.state.commits.length : 0;
            });
            element.addEventListener("compositionend", () => {
              watched.events.push("end");
              const bench = (window as unknown as { benchA?: { state: { commits: number[] } } })
                .benchA;
              watched.commits = bench ? bench.state.commits.length - watched.commits : 0;
              setTimeout(() => {
                watched.composing = false;
              }, 0);
            });
          }
          (window as unknown as { watched: typeof watched }).watched = watched;
        });
        await cdp.send("Input.imeSetComposition", {
          text: "z",
          selectionStart: 1,
          selectionEnd: 1,
        });
        await cdp.send("Input.imeSetComposition", {
          text: "zhong",
          selectionStart: 5,
          selectionEnd: 5,
        });
        await cdp.send("Input.imeSetComposition", {
          text: place.word,
          selectionStart: 2,
          selectionEnd: 2,
        });
        await cdp.send("Input.insertText", { text: place.word });
        const watched = await arm.window.evaluate(
          () =>
            (
              window as unknown as {
                watched: { structural: number; commits: number; events: string[]; kinds: string[] };
              }
            ).watched,
        );
        await arm.close();
        expected = expected.slice(0, offset) + place.word + expected.slice(offset);
        const now = await runsOf(await arm.bytes(), slide, shapeId);
        const text = now.map((run) => run.text).join("");
        const holder = now.find((run) => run.text.includes(place.word));
        const bold = (runs: RunText[]) =>
          runs
            .filter((run) => run.properties.includes('"b":"1"'))
            .map((run) => run.text)
            .join("");
        const propertiesKept =
          JSON.stringify([...new Set(now.map((run) => run.properties))].sort()) ===
          JSON.stringify([...new Set(original.map((run) => run.properties))].sort());
        const result = {
          slide,
          shapeId,
          place: place.name,
          landedOnce: text.split(place.word).length === 2,
          rightPlace: text === expected,
          boldKept: bold(now) === bold(original),
          propertiesKept,
          inPlainRun: holder ? !holder.properties.includes('"b":"1"') : false,
          compositionEvents: watched.events.join(","),
          redrawsWhileComposing: watched.commits,
          structuralChangesWhileComposing: watched.structural,
          changeKinds: [...new Set(watched.kinds)],
          text,
        };
        results.push(result);
        if (!result.rightPlace) expected = text;
      }
    }
  }
  const passed = results.filter(
    (each) =>
      each.landedOnce && each.rightPlace && each.boldKept && each.propertiesKept && each.inPlainRun,
  ).length;
  writeFileSync(
    join(lane, `logs/ime-${arm.name}.json`),
    JSON.stringify({ passed, total: results.length, results }, null, 1),
  );
  await arm.window.evaluate(() => undefined);
  return passed;
}

test("arm A takes Chinese from an input method", async () => {
  const arm = await armA("ime-a");
  console.log("A passed", await measure(arm));
  await arm.app.close();
});

test("arm B takes Chinese from an input method", async () => {
  const arm = await armB("ime-b");
  console.log("B passed", await measure(arm));
  await arm.app.close();
});
