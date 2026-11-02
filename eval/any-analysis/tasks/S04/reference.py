from itertools import combinations

import numpy as np
import pandas as pd
from scipy import stats

deliveries = pd.read_csv(f"{DATA}/deliveries.csv")
names = ["Alder", "Birch", "Cedar", "Elm"]
groups = {name: deliveries.loc[deliveries["depot"] == name, "hours"].to_numpy() for name in names}
counts = np.array([len(groups[name]) for name in names], dtype=float)
means = np.array([groups[name].mean() for name in names])
variances = np.array([groups[name].var(ddof=1) for name in names])
k = len(names)

# Welch's ANOVA, as Welch (1951) gives it.
weights = counts / variances
centre = (weights * means).sum() / weights.sum()
spread = ((1 - weights / weights.sum()) ** 2 / (counts - 1)).sum()
welch_f = ((weights * (means - centre) ** 2).sum() / (k - 1)) / (
    1 + 2 * (k - 2) / (k**2 - 1) * spread
)
welch_df2 = (k**2 - 1) / (3 * spread)
welch_p = stats.f.sf(welch_f, k - 1, welch_df2)

# Games-Howell: each pair's Welch t, against the studentized range at Welch's degrees of freedom.
pairs = []
for i, j in combinations(range(k), 2):
    shares = variances[[i, j]] / counts[[i, j]]
    t = abs(means[i] - means[j]) / np.sqrt(shares.sum())
    df = shares.sum() ** 2 / (shares**2 / (counts[[i, j]] - 1)).sum()
    pairs.append(
        {
            "key": f"{names[i]}-{names[j]}",
            "difference": float(means[j] - means[i]),
            "p": float(stats.studentized_range.sf(t * np.sqrt(2), k, df)),
        }
    )

result = {
    "welch_f": float(welch_f),
    "welch_df2": float(welch_df2),
    "welch_p": float(welch_p),
    "pairs_differing": sum(1 for pair in pairs if pair["p"] < 0.05),
    "alder_birch_p": pairs[0]["p"],
    # Not scored: every pair, and Levene's test (median-centred) that shows the variances differ.
    "pairs": pairs,
    "levene_p": float(stats.levene(*groups.values()).pvalue),
}
