import { expect, test } from "vitest";
import { verificationOf } from "../../src/shared/verification";
import { listedSentences } from "../helpers/checks";
import { setUpWithDocuments } from "../helpers/citations";
import { createTempDataFolder } from "../helpers/core";
import { writeSourceFile } from "../helpers/documents";
import { scriptedModel } from "../helpers/models";
import { verifyWordFile } from "../helpers/verifiedWord";
import { paragraph, wordFile } from "../helpers/word";

test.each([
  { language: "en", claim: "The base rate is currently 5%.", qualifier: "currently" },
  { language: "zh-CN", claim: "基准利率目前为5%。", qualifier: "目前" },
] as const)(
  "an overlapping inventory is repaired with its failed reply, not the same blind request: $language",
  async (row) => {
    let asks = 0;
    let invalid = "";
    const model = scriptedModel(
      () => {
        throw new Error("Finding claims must not run a Check.");
      },
      {
        generate: (call) => {
          const sentences = listedSentences(call.prompt);
          expect(sentences.map(({ text }) => text)).toEqual([row.claim]);
          expect(call.options.maxOutputTokens).toBe(4000);
          asks++;
          if (asks === 1) {
            invalid = JSON.stringify({
              sentences: sentences.map(({ number }) => ({
                number,
                parts: [
                  { kind: "fact", text: row.qualifier, facet: { kind: "time" } },
                  { kind: "fact", text: row.claim },
                ],
              })),
            });
            return { text: invalid };
          }
          expect(JSON.parse(call.prompt).previousReply).toBe(invalid);
          return {
            text: JSON.stringify({
              sentences: sentences.map(({ number }) => ({
                number,
                parts: [
                  { kind: "fact", text: row.qualifier, facet: { kind: "time" } },
                  { kind: "fact", text: "5%" },
                ],
              })),
            }),
          };
        },
      },
    );
    const { core } = await setUpWithDocuments(model, [
      { name: "Rate notice.md", contents: "The base rate is 5%." },
    ]);
    const folder = await createTempDataFolder();
    const path = await writeSourceFile(
      folder,
      "Statement.docx",
      wordFile({ body: paragraph(row.claim) }),
    );
    const verified = await verifyWordFile(core, path);
    const found = await core.findClaims({
      requestId: crypto.randomUUID(),
      mindId: verified.mind.id,
    });
    expect(found).toMatchObject({ kind: "found", claims: 1 });
    expect(asks).toBe(2);
    const client = verified.client;
    await client.settled();
    const claims = verificationOf(client.doc)?.claims;
    expect(claims).toHaveLength(1);
    const parts = claims?.[0]?.parts;
    expect(parts).toHaveLength(2);
    const [facet, ordinary] = parts ?? [];
    expect(facet?.facet?.kind).toBe("time");
    expect(row.claim.slice(facet?.span.start, facet?.span.end)).toBe(row.qualifier);
    expect(ordinary?.facet).toBeUndefined();
    expect(ordinary?.span.start).toBeGreaterThanOrEqual(facet?.span.end ?? row.claim.length);
    expect(row.claim.slice(ordinary?.span.start, ordinary?.span.end)).toContain("5%");
  },
);
