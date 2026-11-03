/**
 * The sentences `npm run eval:whole-read` checks against the long agreements of
 * ./wholeReadDocuments, read whole (README.md): for each of the three clauses,
 * a paraphrase it states, a near miss about another group or thing, and a
 * wrong figure; and two sentences the agreement says nothing of.
 */
import type { Expected, RepeatSentence } from "./cases";
import type { Place, WholeReadLanguage } from "./wholeReadDocuments";

export interface WholeReadSentence extends RepeatSentence {
  /** The clause that settles it; null for one the agreement says nothing of. */
  place: Place | null;
}

const sentence = (
  key: string,
  kind: RepeatSentence["kind"],
  expected: Expected,
  place: Place | null,
  text: string,
): WholeReadSentence => ({ key, kind, expected, place, text });

export const WHOLE_READ_SENTENCES: Readonly<
  Record<WholeReadLanguage, readonly WholeReadSentence[]>
> = {
  en: [
    sentence(
      "pet",
      "paraphrase",
      "supported",
      "early",
      "The lease lets the tenant keep one pet weighing up to 15 kg.",
    ),
    sentence(
      "pet-visitors",
      "near-miss",
      "unsupported",
      "early",
      "The lease lets visitors bring one pet weighing up to 15 kg.",
    ),
    sentence(
      "pet-figure",
      "wrong-figure",
      "contradicted-or-unsupported",
      "early",
      "The lease lets the tenant keep one pet weighing up to 25 kg.",
    ),
    sentence(
      "rent",
      "paraphrase",
      "supported",
      "middle",
      "Each annual rent review can raise the rent by at most 3.5%.",
    ),
    sentence(
      "rent-commercial",
      "near-miss",
      "unsupported",
      "middle",
      "Rent reviews for the building's commercial units are capped at 3.5% a year.",
    ),
    sentence(
      "rent-figure",
      "wrong-figure",
      "contradicted-or-unsupported",
      "middle",
      "Each annual rent review can raise the rent by at most 5%.",
    ),
    sentence(
      "deposit",
      "paraphrase",
      "supported",
      "late",
      "The landlord must return the deposit within 21 days of the tenant moving out.",
    ),
    sentence(
      "deposit-fees",
      "near-miss",
      "unsupported",
      "late",
      "The landlord must refund the letting agent's fees within 21 days of the tenant moving out.",
    ),
    sentence(
      "deposit-figure",
      "wrong-figure",
      "contradicted-or-unsupported",
      "late",
      "The landlord must return the deposit within 10 days of the tenant moving out.",
    ),
    sentence(
      "dish",
      "absent",
      "unsupported",
      null,
      "The tenant may put up a satellite dish on the balcony.",
    ),
    sentence(
      "broadband",
      "absent",
      "unsupported",
      null,
      "The landlord pays for the tenant's broadband.",
    ),
  ],
  "zh-CN": [
    sentence("pet", "paraphrase", "supported", "early", "租约允许承租方养一只15公斤以下的宠物。"),
    sentence(
      "pet-visitors",
      "near-miss",
      "unsupported",
      "early",
      "租约允许访客带一只15公斤以下的宠物入住。",
    ),
    sentence(
      "pet-figure",
      "wrong-figure",
      "contradicted-or-unsupported",
      "early",
      "租约允许承租方养一只25公斤以下的宠物。",
    ),
    sentence("rent", "paraphrase", "supported", "middle", "每年调租时租金涨幅最多3.5%。"),
    sentence(
      "rent-commercial",
      "near-miss",
      "unsupported",
      "middle",
      "楼内商铺的租金每年涨幅不超过3.5%。",
    ),
    sentence(
      "rent-figure",
      "wrong-figure",
      "contradicted-or-unsupported",
      "middle",
      "每年调租时租金涨幅最多5%。",
    ),
    sentence(
      "deposit",
      "paraphrase",
      "supported",
      "late",
      "承租方搬走后21天内，出租方须退还押金。",
    ),
    sentence(
      "deposit-fees",
      "near-miss",
      "unsupported",
      "late",
      "承租方搬走后21天内，出租方须退还中介费。",
    ),
    sentence(
      "deposit-figure",
      "wrong-figure",
      "contradicted-or-unsupported",
      "late",
      "承租方搬走后10天内，出租方须退还押金。",
    ),
    sentence("dish", "absent", "unsupported", null, "承租方可以在阳台上安装卫星天线。"),
    sentence("broadband", "absent", "unsupported", null, "出租方承担承租方的宽带费用。"),
  ],
};
