/**
 * The built-in text recognition model (#397): PaddleOCR's PP-OCRv5 mobile
 * detection and recognition models (Apache-2.0), as ONNX, pinned with their
 * sizes and SHA-256 hashes. Its one recognition model reads Simplified and
 * Traditional Chinese, English and other Latin text, Japanese and pinyin.
 * They are RapidOCR's conversions, downloaded from the copies on Hugging
 * Face, whose bytes match RapidOCR's own release (RapidAI/RapidOCR on
 * ModelScope, onnx/PP-OCRv5): 21 MB together, downloaded the first time a
 * scanned page, or a saved web page's picture, needs reading. The comparison that chose it is in
 * eval/ocr/README.md.
 */
import type { EmbeddingModelSource } from "../../adapters";

export interface TextRecognitionModelDefinition {
  /** What the User sees. */
  name: string;
  /**
   * What read a page's text, recorded with it (`UnitScan.reader`): the
   * model, and the version of how this code reads with it. Bump the version
   * when the reading changes what a page's text would be, so pages read by
   * the older one are read again (see `SCAN_CURRENT_SINCE`).
   */
  reader: string;
  /** The model's folder under `models/` in the data folder. */
  folder: string;
  /** The licence of the models, as an SPDX id. */
  licence: string;
  /** The files the runner loads, relative to the model's folder. */
  files: { detector: string; recognizer: string };
  source: EmbeddingModelSource;
}

export const BUILT_IN_TEXT_RECOGNITION_MODEL: TextRecognitionModelDefinition = {
  name: "PP-OCRv5 mobile",
  reader: "PP-OCRv5 mobile/2",
  folder: "pp-ocrv5-mobile",
  licence: "Apache-2.0",
  files: { detector: "PP-OCRv5_mobile_det.onnx", recognizer: "PP-OCRv5_mobile_rec.onnx" },
  source: {
    baseUrl: "https://huggingface.co/",
    files: [
      {
        path: "PP-OCRv5_mobile_det.onnx",
        url: "breezedeus/cnstd-ppocr-ch_PP-OCRv5_det/resolve/14005c7ab09021b039cdf72a3b21eb51e3a9cf4f/ch_PP-OCRv5_det_infer.onnx",
        size: 4_819_576,
        sha256: "4d97c44a20d30a81aad087d6a396b08f786c4635742afc391f6621f5c6ae78ae",
      },
      {
        path: "PP-OCRv5_mobile_rec.onnx",
        url: "breezedeus/cnocr-ppocr-ch_PP-OCRv5/resolve/5c54978d1cbd0ecf2c2c05b2923d105e16cf5430/ch_PP-OCRv5_rec_infer.onnx",
        size: 16_631_306,
        sha256: "5825fc7ebf84ae7a412be049820b4d86d77620f204a041697b0494669b1742c5",
      },
    ],
  },
};
