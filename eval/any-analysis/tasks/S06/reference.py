import math

import pandas as pd
from scipy.stats import norm

parameters = dict(pd.read_csv(f"{DATA}/parameters.csv").itertuples(index=False))
effects = pd.read_csv(f"{DATA}/effects.csv")["effect"].tolist()

baseline = parameters["Baseline conversion rate"]
z_alpha = norm.ppf(1 - parameters["Significance level (two-sided)"] / 2)
z_beta = norm.ppf(parameters["Power"])


def per_arm(effect):
    """Users per arm by the pooled, the unpooled and Cohen's h formulas, each rounded up."""
    p1, p2 = baseline, baseline + effect
    mean = (p1 + p2) / 2
    spread = p1 * (1 - p1) + p2 * (1 - p2)
    pooled = (z_alpha * math.sqrt(2 * mean * (1 - mean)) + z_beta * math.sqrt(spread)) ** 2 / effect**2
    unpooled = (z_alpha + z_beta) ** 2 * spread / effect**2
    h = 2 * math.asin(math.sqrt(p2)) - 2 * math.asin(math.sqrt(p1))
    cohen = 2 * ((z_alpha + z_beta) / h) ** 2
    return [math.ceil(pooled), math.ceil(unpooled), math.ceil(cohen)]


sizes = {round(effect, 4): per_arm(effect) for effect in effects}

result = {
    "per_arm": per_arm(parameters["Smallest effect worth detecting (absolute)"]),
    "per_arm_0_5": sizes[0.005],
    "per_arm_1_5": sizes[0.015],
    "per_arm_2_0": sizes[0.02],
}
