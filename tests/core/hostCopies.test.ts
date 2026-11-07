import { describe, expect, test } from "vitest";
import { withoutHostCopies } from "../../src/core/reranking/hostCopies";
import { onnxModel } from "../helpers/onnxModels";

describe("A GPU file's copies between host and GPU memory", () => {
  // Names of 90 to 110 letters put a copy node on both sides of 128 bytes, where its length
  // takes one byte fewer once it reads Identity.
  test.each([90, 100, 105, 106, 107, 108, 110])(
    "are read as Identity, and nothing else in the model changes (a node named with %i letters)",
    (letters) => {
      const name = "n".repeat(letters);
      const exported = onnxModel([
        { op: "Neg" },
        { op: "MemcpyToHost", name },
        { op: "MemcpyFromHost", domain: "" },
        { op: "Neg" },
      ]);
      const expected = onnxModel([
        { op: "Neg" },
        { op: "Identity", name },
        { op: "Identity", domain: "" },
        { op: "Neg" },
      ]);

      expect(Array.from(withoutHostCopies(exported))).toEqual(Array.from(expected));
    },
  );

  test("give a session the same result as the exported model", async () => {
    const ort = await import("onnxruntime-node");
    const nodes = [{ op: "Neg" }, { op: "MemcpyToHost" }, { op: "MemcpyFromHost" }];
    const run = async (bytes: Uint8Array) => {
      const session = await ort.InferenceSession.create(bytes);
      const { y } = await session.run({
        x: new ort.Tensor("float32", Float32Array.from([1.5, -2, 3]), [3]),
      });
      await session.release();
      return Array.from(y?.data as Float32Array);
    };

    expect(await run(withoutHostCopies(onnxModel(nodes)))).toEqual([-1.5, 2, -3]);
    expect(await run(onnxModel(nodes))).toEqual([-1.5, 2, -3]);
  });

  test("are left as they are in a model that has none, or where another domain names an op so", () => {
    for (const nodes of [[{ op: "Neg" }], [{ op: "MemcpyFromHost", domain: "com.example" }]]) {
      const exported = onnxModel(nodes);
      const before = Array.from(exported);

      expect(Array.from(withoutHostCopies(exported))).toEqual(before);
    }
  });

  test("leave bytes that can't be read as a model as they were", () => {
    const whole = onnxModel([{ op: "MemcpyFromHost" }]);
    for (const bytes of [whole.slice(0, whole.length - 9), Uint8Array.from([0x0b, 0xff, 0x03])]) {
      const before = Array.from(bytes);

      expect(Array.from(withoutHostCopies(bytes))).toEqual(before);
    }
  });
});
