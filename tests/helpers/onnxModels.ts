/** Small ONNX models written as bytes, as an exporter writes them, for tests of what a session reads. */

const varint = (value: number): number[] => {
  const out: number[] = [];
  let rest = value;
  do {
    const low = rest % 128;
    rest = Math.floor(rest / 128);
    out.push(rest > 0 ? low | 0x80 : low);
  } while (rest > 0);
  return out;
};
const keyed = (field: number, body: number[]) => [
  ...varint(field * 8 + 2),
  ...varint(body.length),
  ...body,
];
const number = (field: number, value: number) => [...varint(field * 8), ...varint(value)];
const text = (value: string) => [...new TextEncoder().encode(value)];

export interface ModelNode {
  op: string;
  domain?: string;
  name?: string;
}

/** A model taking a vector of three floats, `x`, through `nodes` in a row to `y`, with an unused weight after them. */
export function onnxModel(nodes: readonly ModelNode[]): Uint8Array {
  const value = (name: string) => [
    ...keyed(1, text(name)),
    ...keyed(2, keyed(1, [...number(1, 1), ...keyed(2, keyed(1, number(1, 3)))])),
  ];
  const nodeBytes = nodes.flatMap((node, index) =>
    keyed(1, [
      ...keyed(1, text(index === 0 ? "x" : `t${index}`)),
      ...keyed(2, text(index === nodes.length - 1 ? "y" : `t${index + 1}`)),
      ...keyed(3, text(node.name ?? `node${index}`)),
      ...keyed(4, text(node.op)),
      ...(node.domain === undefined ? [] : keyed(7, text(node.domain))),
      ...keyed(6, text("Copy from/to host memory")),
    ]),
  );
  const weight = keyed(5, [
    ...number(1, 3),
    ...number(2, 1),
    ...keyed(8, text("w")),
    ...keyed(9, Array(12).fill(7)),
  ]);
  const graph = [
    ...nodeBytes,
    ...keyed(2, text("g")),
    ...weight,
    ...keyed(11, value("x")),
    ...keyed(12, value("y")),
  ];
  return Uint8Array.from([
    ...number(1, 8),
    ...keyed(7, graph),
    ...keyed(8, [...keyed(1, text("")), ...number(2, 14)]),
  ]);
}
