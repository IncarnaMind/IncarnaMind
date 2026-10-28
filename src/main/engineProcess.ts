/**
 * Every engine process, a utility process that runs a built-in model, starts here, and biome.json
 * refuses `utilityProcess` anywhere else in src/main. ONNX Runtime sends usage telemetry unless it
 * is told not to (#2145): its macOS and Linux libraries connect to Microsoft's OneCollector service
 * around the app's proxy settings and keep a device id and an event queue in a folder of their own,
 * and its Windows libraries write ETW events.
 */
import { type UtilityProcess, utilityProcess } from "electron";

/**
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

export function startEngineProcess(
  modulePath: string,
  args: string[],
  serviceName: string,
): UtilityProcess {
  return utilityProcess.fork(modulePath, args, {
    serviceName,
    stdio: "inherit",
    env: engineEnvironment(),
  });
}
