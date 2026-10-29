/**
 * Every engine process, a utility process that runs a built-in model, starts here, and biome.json
 * refuses `utilityProcess` anywhere else in src/main. ONNX Runtime sends usage telemetry unless it
 * is told not to (#2145): its macOS and Linux libraries connect to Microsoft's OneCollector service
 * around the app's proxy settings and keep a device id and an event queue in a folder of their own,
 * and its Windows libraries write ETW events. See ./engineEnvironment for how each is turned off.
 */
import { type UtilityProcess, utilityProcess } from "electron";
import { engineEnvironment } from "./engineEnvironment";

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
