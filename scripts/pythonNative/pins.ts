/**
 * What `run_code`'s Python is built from (ADR-0025, scripts/pythonNative.ts), beside lock.txt:
 * python-build-standalone's archives with the SHA-256s its release's SHA256SUMS gives, the uv that
 * writes the lock and installs it, and the platform tag of the oldest system each platform's wheels
 * must run on (macOS 12, glibc 2.28). A change here or to the lock makes a different runtime.
 */
export const PINS = {
  python: "3.14.10",
  pythonBuildStandalone: "20261026",
  uv: "0.13.6",
  platforms: {
    "darwin-arm64": {
      runtime: {
        file: "cpython-3.14.10+20261026-aarch64-apple-darwin-install_only_stripped.tar.gz",
        sha256: "95eb8c87d16af37c54e9765e31d8c56c0d8ffa9968ea0f704f73a9b83f84e9f9",
      },
      // The install_only archives carry only CPython's own LICENSE.txt; the texts of what it is
      // built with are in this one's python/licenses/.
      licences: {
        file: "cpython-3.14.10+20261026-aarch64-apple-darwin-pgo+lto-full.tar.zst",
        sha256: "137db511241f7693ddc57586af1744c7b6375982ab4c31c4a82d10115657d462",
      },
      wheels: "macosx_12_0_arm64",
    },
    "linux-x64": {
      runtime: {
        file: "cpython-3.14.10+20261026-x86_64-unknown-linux-gnu-install_only_stripped.tar.gz",
        sha256: "4d3c16c59ed0802a3d1d34d8bce504b15ceeaff39d62dadecc6a9fa803412aed",
      },
      licences: {
        file: "cpython-3.14.10+20261026-x86_64-unknown-linux-gnu-pgo+lto-full.tar.zst",
        sha256: "4a2823d5deacb631e21b3c8387a1ec9be57e1b0ed37b7770e2e71cfe7b94eb94",
      },
      wheels: "manylinux_2_28_x86_64",
    },
  },
} as const;

export type NativePlatform = keyof typeof PINS.platforms;
