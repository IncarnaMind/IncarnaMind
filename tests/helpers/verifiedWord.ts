/**
 * A Word file someone else wrote, to verify (#110): claims the scripted model checks as `PLANS`
 * says against a Tides PDF, a sentence holding another author's tracked insertion, and another
 * author's comment on one claim. For the core's tests and the Word corpus's LibreOffice check.
 */
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Core, VerifyClaimsInput } from "../../src/core";
import { COMMENTS_CONTENT_TYPE } from "../../src/core/exports/wordml";
import { INLINE_NODE } from "../../src/shared/sentences";
import { checkingModel, type Plan } from "./checks";
import { createTempDataFolder, startCore } from "./core";
import { addAndProcess, waitForProcessing, writeSourceFile } from "./documents";
import { unzip } from "./docx";
import { connectToMind } from "./mindClient";
import { type ModelCall, scriptedModels } from "./models";
import { buildPdf } from "./pdf";
import { commented, paragraph, run, tracked, wordFile } from "./word";
import { buildZip } from "./zip";

export const SUPPORTED = "Spring tides come at new and full moon.";
export const CONTRADICTED = "Harbours publish the times of high water every week.";
export const DIFFERS = "The harbour wall was raised in 1990.";
export const NOT_FOUND = "Penguins nest on the cliffs above the harbour.";
/** Their comment's end and its mark follow the full stop: the sentence holds them, as it would a Citation's marker. */
export const COMMENTED = `${NOT_FOUND}${INLINE_NODE}${INLINE_NODE}`;
export const THANKS = "Thank you for reading this report.";
export const THEIRS_ADDED = " and closes at dusk";

export const PLANS: Record<string, Plan> = {
  [SUPPORTED]: {
    verdict: "supported",
    quote: "Spring tides happen at new moon and at full moon",
    says: "Tides says spring tides happen at new and full moon.",
  },
  [CONTRADICTED]: {
    verdict: "contradicted",
    quote: "Harbours publish the times of high water every year.",
    says: "Tides says harbours publish them every year, not every week.",
  },
  [DIFFERS]: { verdict: "unsupported", quote: "The harbour wall was raised in 1984." },
  [NOT_FOUND]: { verdict: "unsupported" },
  [COMMENTED]: { verdict: "unsupported" },
};

/** The User's evidence: a PDF of two pages. */
const TIDES = buildPdf([
  {
    lines: [
      "Tides",
      "Spring tides happen at new moon and at full moon, when the Sun and the Moon pull together.",
      "Harbours publish the times of high water every year.",
    ],
  },
  { lines: ["The harbour", "The harbour wall was raised in 1984."] },
]);

/** The other side's comment on one of their claims, with its XML as the file has it. */
export const DANA = commented(7, "Dana Kim", "Please confirm the source.", run(NOT_FOUND));

/** The report someone else wrote: a heading, claims, their tracked insertion, their comment, thanks. */
const REPORT_BODY = [
  paragraph("Harbour report", { style: "Heading1" }),
  paragraph(SUPPORTED),
  paragraph(CONTRADICTED),
  paragraph(
    `${run("The harbour opens at dawn")}${tracked("ins", 3, "Priya Nair", THEIRS_ADDED)}${run(".")}`,
  ),
  paragraph(DIFFERS),
  paragraph(DANA.inline),
  paragraph(THANKS),
].join("");

/** A Word file as Word writes it: a comments part has its own content type. */
function asWordWrites(bytes: Buffer): Buffer {
  return buildZip(
    [...unzip(bytes)].map(([name, data]) => ({
      name,
      data:
        name === "[Content_Types].xml" && bytes.includes("word/comments.xml")
          ? data
              .toString("utf8")
              .replace(
                "</Types>",
                `<Override PartName="/word/comments.xml" ContentType="${COMMENTS_CONTENT_TYPE}"/></Types>`,
              )
          : data,
    })),
  );
}

export const REPORT = asWordWrites(wordFile({ body: REPORT_BODY, comments: DANA.comment }));

/** The same report with no comment in it, so the export makes the comments part. */
export const UNCOMMENTED_REPORT = asWordWrites(
  wordFile({ body: REPORT_BODY.replace(DANA.inline, run(NOT_FOUND)) }),
);

/** A core with the Tides PDF, a model on this computer that checks as `PLANS` (and `more`) say, and the report on disk. */
export async function setUpWordVerify(
  calls?: ModelCall[],
  language: "en" | "zh-CN" = "en",
  more: Record<string, Plan> = {},
) {
  const core = startCore(await createTempDataFolder(), {
    createChatModel: scriptedModels(checkingModel({ ...PLANS, ...more }, calls)).createChatModel,
  });
  await core.updateSettings({ user: { language } });
  await core.saveChatProvider({ kind: "ollama", modelId: "local-model" });
  const sources = await createTempDataFolder();
  const [tides] = await addAndProcess(core, [await writeSourceFile(sources, "Tides.pdf", TIDES)]);
  const report = join(sources, "Harbour report.docx");
  await writeFile(report, REPORT);
  return { core, sources, report, tides };
}

export const verifyRequest = (mindId: string): VerifyClaimsInput => ({
  requestId: crypto.randomUUID(),
  mindId,
});

/** Verifies a file: its Mind, with a client, once the Document it verifies is read. */
export async function verifyWordFile(core: Core, path: string) {
  const result = await core.verifyDocument({ path });
  if (!result.ok) throw new Error(`The report wasn't verified: ${JSON.stringify(result)}`);
  await waitForProcessing(core, [result.documentId]);
  const client = await connectToMind(core, result.mind.id);
  await client.settled();
  return { ...result, client };
}
