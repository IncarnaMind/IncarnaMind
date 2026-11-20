import type { EmbeddingModelSource, ModelFile } from "../../core/adapters";

const RELEASE = "https://github.com/NVIDIA/NeMo-Speech.cpp/releases/download/v0.3.0/";
export const roomModel: EmbeddingModelSource = {
  baseUrl:
    "https://huggingface.co/nvidia/diar_streaming_sortformer_4spk-v2/resolve/5240a64075176943f677d30fa2171c780229f341/",
  files: [
    {
      path: "diar_streaming_sortformer_4spk-v2.q8_0.gguf",
      size: 147075776,
      sha256: "0679cfeb1ce356d0dea9470b31274f4bfc7eb927497d82005483770666da998a",
    },
  ],
};

const releases: Readonly<Record<string, ModelFile>> = {
  "darwin-arm64": {
    path: "nemo-speech-0.3.0-macos-aarch64-metal.tar.gz",
    size: 7239335,
    sha256: "2b972ed8b5dba07492212acf8cb75cbf34ecb141198ffa1997febe84b7c4d9ed",
  },
  "darwin-x64": {
    path: "nemo-speech-0.3.0-macos-x86_64-cpu.tar.gz",
    size: 7742012,
    sha256: "97e98aa5eb82dffa4f513f26336b5301d792c9fb43f720ac8f9520a0e92ffe3f",
  },
  "linux-arm64": {
    path: "nemo-speech-0.3.0-linux-aarch64-cpu.tar.gz",
    size: 9064856,
    sha256: "56858eaf50d19b05902c043f65d0057352bdc107ae380c41053bfbddfc204bf1",
  },
  "linux-x64": {
    path: "nemo-speech-0.3.0-linux-x86_64-cpu.tar.gz",
    size: 9605101,
    sha256: "255f12b722ab15b2a38a51cf125d56e3fa97058b528f7e895b39d6a473deb06e",
  },
  "win32-x64": {
    path: "nemo-speech-0.3.0-windows-x86_64-cpu.zip",
    size: 8694509,
    sha256: "4ed9740e361e4653f56c3dce7d1e81883a1c8b831c1bd7d01567fff1130b5b05",
  },
};

export function roomEngine(platform: string, arch: string): EmbeddingModelSource | undefined {
  const file = releases[`${platform}-${arch}`];
  return file ? { baseUrl: RELEASE, files: [file] } : undefined;
}
