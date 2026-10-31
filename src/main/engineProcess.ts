/**
 * Every engine process, a utility process that runs a built-in model, starts here, and biome.json
 * refuses `utilityProcess` anywhere else in src/main. ONNX Runtime sends usage telemetry unless it
 * is told not to (#2145): its macOS and Linux libraries connect to Microsoft's OneCollector service
 * around the app's proxy settings and keep a device id and an event queue in a folder of their own,
 * and its Windows libraries write ETW events. See ./engineEnvironment for how each is turned off.
 */
import { type UtilityProcess, utilityProcess } from "electron";
import { engineEnvironment } from "./engineEnvironment";

/** An engine process: the module it runs, and the name the system lists it under. */
export interface EngineProcess {
  modulePath: string;
  serviceName: string;
}

export function startEngineProcess(engine: EngineProcess, args: string[]): UtilityProcess {
  return utilityProcess.fork(engine.modulePath, args, {
    serviceName: engine.serviceName,
    stdio: "inherit",
    env: engineEnvironment(),
  });
}
