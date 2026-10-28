import { type Figure, readFigures, readingsOf, readStatedUnits } from "../../../shared/figures";
import type { InputNumber } from "../../api";
import { documentFigureContext } from "../calculations";
import { statedFigure } from "./calculated";
import type { ReadVerdict } from "./prompt";

export function needsCalculation({
  claim,
  verdict,
  attempted,
  computed,
  citations,
  inputs,
  unstatedUnit,
}: {
  claim: string;
  verdict: ReadVerdict;
  attempted: boolean;
  computed: readonly Figure[];
  citations: readonly { quote: string; units: readonly { text: string }[] }[];
  inputs: readonly InputNumber[];
  unstatedUnit: boolean;
}): boolean {
  const context = documentFigureContext(citations.flatMap((citation) => citation.units));
  const own = documentFigureContext([{ text: claim }]);
  const claimFigures = readFigures(claim, own.language ? own : { ...context, header: null });
  if (claimFigures.length === 0 && !attempted) return false;
  if (
    verdict.verdict === "unsupported" &&
    verdict.topic === "not found" &&
    !attempted &&
    !verdict.calculations?.length
  )
    return false;
  const matches = (a: Pick<Figure, "value" | "unit">, b: Pick<InputNumber, "value" | "unit">) =>
    a.value === b.value &&
    a.unit.kind === b.unit.kind &&
    (a.unit.kind !== "currency" || (b.unit.kind === "currency" && a.unit.code === b.unit.code)) &&
    (a.unit.kind !== "other" || (b.unit.kind === "other" && a.unit.word === b.unit.word));
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
  if (computed.length > 0 && unstatedUnit) return false;
  const available = [
    ...citations.flatMap((citation) => {
      const units = citation.units;
      const source = units.map((unit) => unit.text).join("\n");
      const context = documentFigureContext(units);
      const statements = readStatedUnits(source, context);
      return [
        ...readFigures(citation.quote, context),
        ...(statements.length === 1
          ? readFigures(citation.quote, { ...context, header: statements[0]?.chars }).flatMap(
              readingsOf,
            )
          : []),
      ];
    }),
    ...inputs,
  ];
  const unused = [...computed];
  if (
    claimFigures.some((figure) => {
      const at = unused.findIndex((number) => matches(figure, number));
      if (at >= 0) {
        unused.splice(at, 1);
        return false;
      }
      return !available.some((source) => matches(figure, source));
    })
  )
    return verdict.verdict === "supported" || computed.length === 0;
  return false;
}
