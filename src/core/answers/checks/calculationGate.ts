import { type Figure, readFigures, readingsOf, readStatedUnits } from "../../../shared/figures";
import type { Citation, InputNumber } from "../../api";
import { documentFigureContext } from "../calculations";
import { figuresInClaim, statedFigure } from "./calculated";
import type { ReadVerdict } from "./prompt";
import { unitNotStated } from "./units";

export async function needsCalculation({
  claim,
  verdict,
  attempted,
  computed,
  citations,
  inputs,
  confirm,
}: {
  claim: string;
  verdict: ReadVerdict;
  attempted: boolean;
  computed: readonly Figure[];
  citations: readonly { citation: Citation; units: readonly { text: string }[] }[];
  inputs: readonly InputNumber[];
  confirm(figure: Figure, citations: readonly Citation[]): Promise<boolean>;
}): Promise<boolean> {
  const context = documentFigureContext(citations.flatMap((citation) => citation.units));
  const own = documentFigureContext([{ text: claim }]);
  const claimFigures = figuresInClaim(claim, own.language ? own : { ...context, header: null });
  if (claimFigures.length === 0 && !attempted) return false;
  if (
    verdict.verdict === "unsupported" &&
    verdict.topic === "not found" &&
    !attempted &&
    !verdict.calculations?.length
  )
    return false;
  const sameUnit = (a: Figure["unit"], b: InputNumber["unit"]) =>
    a.kind === b.kind &&
    (a.kind !== "currency" || (b.kind === "currency" && a.code === b.code)) &&
    (a.kind !== "other" || (b.kind === "other" && a.word === b.word));
  const matches = (a: Pick<Figure, "value" | "unit">, b: Pick<InputNumber, "value" | "unit">) =>
    a.value === b.value && sameUnit(a.unit, b.unit);
  const remaining = [...computed];
  if (
    verdict.calculations?.some((named) => {
      const wanted = statedFigure(claim, named, context);
      const at = wanted ? remaining.findIndex((number) => matches(wanted, number)) : -1;
      if (at < 0) return true;
      remaining.splice(at, 1);
      return false;
    })
  )
    return true;
  const unique = [
    ...new Map(
      citations.map((each) => [
        JSON.stringify([
          each.citation.documentId,
          each.citation.contentHash,
          each.citation.passageId,
          each.citation.quote,
        ]),
        each,
      ]),
    ).values(),
  ];
  const sources = unique.map(({ citation, units }) => {
    const context = documentFigureContext(units);
    const statements = readStatedUnits(units.map((unit) => unit.text).join("\n"), context);
    const header = statements.length === 1 ? statements[0]?.chars : undefined;
    const figures = readFigures(citation.quote, context);
    const alternatives = header ? readFigures(citation.quote, { ...context, header }) : [];
    return {
      citation,
      figures: figures.map((figure) => [
        figure,
        ...alternatives
          .filter((each) => each.start === figure.start && each.end === figure.end)
          .flatMap(readingsOf),
      ]),
    };
  });
  const available = [...sources.flatMap(({ figures }) => figures.flat()), ...inputs];
  const quoted = citations.map(({ citation, units }) => ({
    cited: () => citation.quote,
    document: () => units.map((unit) => unit.text).join("\n"),
  }));
  const unused = [...computed];
  for (const figure of claimFigures) {
    const at = unused.findIndex((number) => matches(figure, number));
    if (at >= 0) {
      unused.splice(at, 1);
      continue;
    }
    if (unitNotStated(figure.chars, quoted) !== null) continue;
    if (!available.some((source) => matches(figure, source))) {
      if (verdict.verdict === "supported" || (attempted && computed.length === 0)) return true;
      continue;
    }
    if (verdict.verdict !== "supported") continue;
    const inUnit = sources.flatMap((source) =>
      source.figures.filter((readings) =>
        readings.some((each) => sameUnit(figure.unit, each.unit)),
      ),
    );
    if (
      inUnit.length > 1 &&
      inUnit.some((readings) => readings.some((each) => matches(figure, each)))
    ) {
      if (
        !(await confirm(
          figure,
          sources.map(({ citation }) => citation),
        ))
      )
        return true;
    }
  }
  return false;
}
