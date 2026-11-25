/**
 * A slide's shapes by their id (cNvPr), which an edit by hand names (#149). One shape is stored
 * once, or twice as the choice and fallback of one mc:AlternateContent; any other two shapes with
 * one id are told apart by nothing an edit carries, so neither is offered or edited.
 */
import { child, elements, local, walk, type XmlElement } from "./xml";

const SHAPES = new Set(["sp", "pic", "graphicFrame", "grpSp", "cxnSp"]);

/** A shape's id, from its non-visual properties. */
export function shapeIdOf(element: XmlElement): string | undefined {
  if (!SHAPES.has(local(element.name))) return undefined;
  const nv = elements(element).find((each) => local(each.name).startsWith("nv"));
  return (nv && child(nv, "cNvPr"))?.attrs.id;
}

/** Every element with this shape id, in document order. */
const withId = (root: XmlElement, id: string) =>
  [...walk(root)].filter((element) => shapeIdOf(element) === id);

/**
 * The copies of the shape with this id: one, or the two halves of one mc:AlternateContent. Null
 * when shapes that aren't copies of each other share the id.
 */
export function copiesOfShape(root: XmlElement, id: string): XmlElement[] | null {
  const found = withId(root, id);
  if (found.length <= 1) return found;
  if (found.length !== 2) return null;
  for (const alternate of walk(root)) {
    if (local(alternate.name) !== "AlternateContent") continue;
    const halves = elements(alternate);
    // One mc:Choice and its mc:Fallback, one copy in each: a second Choice is another shape.
    if (
      halves.length !== 2 ||
      local(halves[0]?.name ?? "") !== "Choice" ||
      local(halves[1]?.name ?? "") !== "Fallback"
    )
      continue;
    const inHalf = (half: XmlElement | undefined) =>
      found.filter((element) => half !== undefined && new Set(walk(half)).has(element)).length;
    if (inHalf(halves[0]) === 1 && inHalf(halves[1]) === 1) return found;
  }
  return null;
}

/** The ids on a slide that more than one shape carries, not counting the two halves of one AlternateContent. */
export function sharedShapeIds(root: XmlElement): Set<string> {
  const ids = new Set<string>();
  for (const element of walk(root)) {
    const id = shapeIdOf(element);
    if (id !== undefined) ids.add(id);
  }
  return new Set([...ids].filter((id) => copiesOfShape(root, id) === null));
}
