/**
 * A scan's page images against real models (#1613): with a cloud model, Organize
 * sends no image until the User allows the page images, the scan waits and says
 * why, and once they are allowed the model reads the page and files the scan in the
 * right Folder, in English (Claude Haiku 5.5) and in Chinese (Kimi K2.6, International
 * endpoint). The scans are the synthetic pages of tests/fixtures/scans. Each model runs
 * only with its key in the environment (INCARNAMIND_LIVE_ANTHROPIC_KEY,
 * INCARNAMIND_LIVE_KIMI_KEY) and makes no request without one; a run costs a few cents.
 */
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { wrapLanguageModel } from "ai";
import { describe, expect, test, vi } from "vitest";
import type { ChatProviderKind } from "../../src/core";
import { createAiSdkChatModel } from "../../src/core";
import { createTempDataFolder, startCore } from "../helpers/core";
import { addAndProcess } from "../helpers/documents";

const SCANS = join(__dirname, "../fixtures/scans");

const LIVE: {
  name: string;
  kind: ChatProviderKind;
  endpoint?: string;
  modelId: string;
  apiKey: string | undefined;
  service: string;
  scan: string;
  expected: string;
}[] = [
  {
    name: "Claude Haiku 5.5",
    kind: "anthropic",
    modelId: "claude-haiku-5-5",
    apiKey: process.env.INCARNAMIND_LIVE_ANTHROPIC_KEY,
    service: "https://api.anthropic.com",
    scan: "en-clean.jpg",
    expected: "Contracts",
  },
  {
    name: "Kimi K2.6",
    kind: "kimi",
    endpoint: "intl",
    modelId: "kimi-k2.6",
    apiKey: process.env.INCARNAMIND_LIVE_KIMI_KEY,
    service: "https://api.moonshot.ai",
    scan: "zh-clean.jpg",
    expected: "Leases",
  },
];

/** A one-page PDF of a JPEG, as a scanner makes one. */
function pdfOfJpeg(jpeg: Buffer): Buffer {
  let at = 2;
  let size: [number, number] | null = null;
  while (at < jpeg.length && !size) {
    if (jpeg[at] !== 0xff) {
      at++;
      continue;
    }
    const marker = jpeg[at + 1] ?? 0;
    if (marker >= 0xc0 && marker <= 0xc3)
      size = [jpeg.readUInt16BE(at + 7), jpeg.readUInt16BE(at + 5)];
    else at += 2 + jpeg.readUInt16BE(at + 2);
  }
  if (!size) throw new Error("Not a JPEG.");
  const [width, height] = size;
  const content = `q ${width} 0 0 ${height} 0 0 cm /Scan Do Q`;
  const parts: Buffer[] = [Buffer.from("%PDF-1.4\n")];
  const offsets: number[] = [];
  const add = (body: Buffer | string) => {
    offsets.push(parts.reduce((total, part) => total + part.length, 0));
    parts.push(
      Buffer.from(`${offsets.length} 0 obj\n`),
      Buffer.from(body),
      Buffer.from("\nendobj\n"),
    );
  };
  add("<< /Type /Catalog /Pages 2 0 R >>");
  add("<< /Type /Pages /Kids [3 0 R] /Count 1 >>");
  add(
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] /Resources << /XObject << /Scan 4 0 R >> >> /Contents 5 0 R >>`,
  );
  add(
    Buffer.concat([
      Buffer.from(
        `<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`,
      ),
      jpeg,
      Buffer.from("\nendstream"),
    ]),
  );
  add(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
  const xref = parts.reduce((total, part) => total + part.length, 0);
  const table = offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  parts.push(
    Buffer.from(
      `xref\n0 ${offsets.length + 1}\n0000000000 65535 f \n${table}trailer\n<< /Size ${offsets.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`,
    ),
  );
  return Buffer.concat(parts);
}

describe.each(LIVE)("$name, live", (live) => {
  test.skipIf(live.apiKey === undefined)(
    "a scan's page images go only once they are allowed, and then the model files it right",
    { timeout: 300_000 },
    async () => {
      const images: number[] = [];
      const core = startCore(await createTempDataFolder(), {
        createChatModel: (spec) =>
          wrapLanguageModel({
            model: createAiSdkChatModel(spec),
            middleware: {
              specificationVersion: "v4",
              wrapGenerate: async ({ doGenerate, params }) => {
                const sent = params.prompt.flatMap((message) =>
                  typeof message.content === "string"
                    ? []
                    : message.content.filter(
                        (part) => part.type === "file" && part.mediaType.startsWith("image/"),
                      ),
                );
                if (JSON.stringify(params.prompt).includes("You organise one Document")) {
                  images.push(sent.length);
                }
                return doGenerate();
              },
            },
          }),
      });
      core.on("consent.requested", (asked) => void core.respondToConsent(asked.requestId, true));
      const provider = await core.saveChatProvider({
        kind: live.kind,
        modelId: live.modelId,
        apiKey: live.apiKey ?? "",
        ...(live.endpoint && { endpoint: live.endpoint }),
      });
      for (const [name, description] of [
        ["Contracts", "Agreements between companies, with their payment terms and termination"],
        ["Leases", "Rental and lease agreements for property"],
        ["Invoices", "Invoices and receipts"],
      ] as const) {
        await core.createLibraryGroup({ name, description });
      }
      await core.saveLibrarySettings({
        classifier: { kind: "chat", choice: { providerId: provider.id, modelId: live.modelId } },
        automatic: false,
      });
      const folder = await createTempDataFolder();
      const file = join(folder, "Scan 0042.pdf");
      await writeFile(file, pdfOfJpeg(await readFile(join(SCANS, live.scan))));
      const [scan] = await addAndProcess(core, [file]);
      if (!scan) throw new Error("The scan wasn't added.");
      expect(scan.status).toBe("no-text");
      const assignment = async () =>
        (await core.getLibrary()).assignments.find((each) => each.documentId === scan.id);

      await core.classifyDocuments([scan.id]);
      await vi.waitFor(async () =>
        expect(await assignment()).toMatchObject({
          status: "waiting",
          error: { wording: { key: "error.library.scanImagesOff" } },
        }),
      );
      expect(images).toEqual([]);

      await core.allowDataFlow("scan-images", live.service);
      await vi.waitFor(async () => expect((await assignment())?.status).toBe("classified"), {
        timeout: 120_000,
      });
      const { groups } = await core.getLibrary();
      const filed = (await assignment())?.groupId;
      expect(groups.find((group) => group.id === filed)?.name).toBe(live.expected);
      expect(images.length).toBeGreaterThan(0);
      expect(Math.max(...images)).toBeLessThanOrEqual(3);
      expect(Math.min(...images)).toBeGreaterThan(0);
    },
  );
});
