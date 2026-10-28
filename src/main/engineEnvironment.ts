/**
 * What the engine processes run with, beside the app's own environment, so that ONNX Runtime's
 * usage telemetry is off (#2145). No Electron imports: the unit tests and the evaluation set it too.
 *
 * `ORT_DISABLE_TELEMETRY` is the runtime's own opt-out. The macOS and Linux libraries read it
 * before they connect or write a file; the Windows ones don't. The only switch onnxruntime-node's
 * Windows library has from outside is `ORT_RUNNING_UNIT_TESTS`, which ONNX Runtime's own tests set:
 * the library then never registers its ETW provider. onnxruntime-node has no call that reaches the
 * library's DisableTelemetryEvents. The speech engine's older Windows library reads neither.
 * tests/main/runtimeLibraries.test.ts fails when a new onnxruntime-node stops reading a name.
 */
export function engineEnvironment(
  base: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  return {
    ...base,
    ORT_DISABLE_TELEMETRY: "1",
    ...(platform === "win32" && { ORT_RUNNING_UNIT_TESTS: "1" }),
  };
}
