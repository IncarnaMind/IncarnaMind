/**
 * A model's file as a WebGPU session should read it (#2532). The built-in reranking model's GPU
 * file is Optimum's O4 export, made for CUDA, and it keeps as nodes the copies a CUDA session put
 * from host to GPU memory (`MemcpyFromHost`), one in each of its twelve layers. A WebGPU session
 * runs them as written: the value each copies is on the GPU there, so the session first reads it
 * back to the host, and each read waits for all the GPU was given, twelve times a batch. A copy
 * changes no value, so each is read as `Identity`, which the session's optimizer removes, and every
 * score stays the same, bit for bit. A `MemcpyToHost` is the same copy the other way.
 */

const MODEL_GRAPH = 7;
const GRAPH_NODE = 1;
const NODE_OP_TYPE = 4;
const NODE_DOMAIN = 7;
const LENGTH_DELIMITED = 2;
const HOST_COPIES = new Set(["MemcpyFromHost", "MemcpyToHost"]);
const IDENTITY = new TextEncoder().encode("Identity");

interface Field {
  number: number;
  /** Where its key starts. */
  at: number;
  /** Where its value starts, after any length. */
  start: number;
  end: number;
  lengthDelimited: boolean;
}

class Unreadable extends Error {}

function readVarint(bytes: Uint8Array, at: number, end: number): [value: number, next: number] {
  let value = 0;
  let scale = 1;
  for (let position = at; position < end && position < at + 10; position++) {
    const byte = bytes[position] ?? 0;
    value += (byte & 0x7f) * scale;
    if ((byte & 0x80) === 0) return [value, position + 1];
    scale *= 128;
  }
  throw new Unreadable();
}

function varint(value: number): number[] {
  const out: number[] = [];
  let rest = value;
  do {
    const low = rest % 128;
    rest = Math.floor(rest / 128);
    out.push(rest > 0 ? low | 0x80 : low);
  } while (rest > 0);
  return out;
}

function fieldsOf(bytes: Uint8Array, start: number, end: number): Field[] {
  const fields: Field[] = [];
  let position = start;
  while (position < end) {
    const at = position;
    const [key, afterKey] = readVarint(bytes, position, end);
    const number = Math.floor(key / 8);
    const wire = key % 8;
    let valueStart = afterKey;
    let valueEnd: number;
    if (wire === 0) valueEnd = readVarint(bytes, afterKey, end)[1];
    else if (wire === 1) valueEnd = afterKey + 8;
    else if (wire === 5) valueEnd = afterKey + 4;
    else if (wire === LENGTH_DELIMITED) {
      const [length, afterLength] = readVarint(bytes, afterKey, end);
      valueStart = afterLength;
      valueEnd = afterLength + length;
    } else throw new Unreadable();
    if (valueEnd > end) throw new Unreadable();
    fields.push({
      number,
      at,
      start: valueStart,
      end: valueEnd,
      lengthDelimited: wire === LENGTH_DELIMITED,
    });
    position = valueEnd;
  }
  return fields;
}

const keyed = (number: number, body: ArrayLike<number>) => [
  ...varint(number * 8 + LENGTH_DELIMITED),
  ...varint(body.length),
  ...Array.from(body),
];

const textOf = (bytes: Uint8Array, field: Field | undefined) =>
  field ? new TextDecoder().decode(bytes.subarray(field.start, field.end)) : "";

/** The node rewritten as `Identity` if it is a copy between host and GPU memory; null if not. */
function asIdentity(bytes: Uint8Array, node: Field): number[] | null {
  const parts = fieldsOf(bytes, node.start, node.end);
  // A field given twice is read as its last, as protobuf reads it.
  const opType = parts.findLast((part) => part.number === NODE_OP_TYPE && part.lengthDelimited);
  const domain = textOf(
    bytes,
    parts.findLast((part) => part.number === NODE_DOMAIN && part.lengthDelimited),
  );
  if (!HOST_COPIES.has(textOf(bytes, opType)) || (domain !== "" && domain !== "ai.onnx"))
    return null;
  const body = parts.flatMap((part) =>
    part === opType ? keyed(NODE_OP_TYPE, IDENTITY) : Array.from(bytes.subarray(part.at, part.end)),
  );
  return keyed(GRAPH_NODE, body);
}

/**
 * `model` (an ONNX file's bytes) with the main graph's copies between host and GPU memory read as
 * `Identity`. It is rewritten in place, and the part of it holding the result is returned, so a
 * model of hundreds of megabytes isn't copied to be rewritten. A model with no such copy, or one
 * that can't be read as a model, comes back as it was, the same array.
 */
export function withoutHostCopies(model: Uint8Array): Uint8Array {
  let edits: { start: number; end: number; bytes: number[] }[];
  try {
    const graph = fieldsOf(model, 0, model.length).find(
      (field) => field.number === MODEL_GRAPH && field.lengthDelimited,
    );
    if (!graph) return model;
    const nodes = fieldsOf(model, graph.start, graph.end).flatMap((field) => {
      if (field.number !== GRAPH_NODE || !field.lengthDelimited) return [];
      const bytes = asIdentity(model, field);
      return bytes ? [{ start: field.at, end: field.end, bytes }] : [];
    });
    if (nodes.length === 0) return model;
    const shrunk = nodes.reduce((sum, node) => sum + node.end - node.start - node.bytes.length, 0);
    const graphLength = graph.end - graph.start - shrunk;
    edits = [
      {
        start: graph.at,
        end: graph.start,
        bytes: [...varint(MODEL_GRAPH * 8 + LENGTH_DELIMITED), ...varint(graphLength)],
      },
      ...nodes,
    ];
  } catch (error) {
    if (error instanceof Unreadable) return model;
    throw error;
  }
  // Every edit is no longer than what it replaces, so writing from the start never overtakes
  // the bytes still to be read.
  let write = 0;
  let read = 0;
  for (const edit of edits) {
    model.copyWithin(write, read, edit.start);
    write += edit.start - read;
    model.set(edit.bytes, write);
    write += edit.bytes.length;
    read = edit.end;
  }
  model.copyWithin(write, read, model.length);
  write += model.length - read;
  return model.subarray(0, write);
}
