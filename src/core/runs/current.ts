import { AsyncLocalStorage } from "node:async_hooks";
import type { Money } from "../api";

/**
 * The Task whose work is running, through every await below it: the meter
 * keys each model request to it (`model_requests.run_id`), so a Task's cost
 * can be told without passing its id through the Answer engine. `budget`: the
 * most its requests billed per token may cost in all, which the meter never
 * lets them pass (a whole read's, #1554).
 */
export const currentTask = new AsyncLocalStorage<{ id: string; budget?: Money }>();
