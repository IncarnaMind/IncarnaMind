import type { Money } from "../core/api";

/**
 * The most judging one Answer's sentences may spend (#2311), on the meter that holds a whole read
 * to its budget (#1554) and toward the monthly cap. A model on this computer costs nothing, and a
 * plan's limit is its own. Check the rest goes past it, once the User has seen what it costs.
 */
export const ANSWER_CHECKING_LIMIT: Money = { currency: "USD", amount: 0.25 };
