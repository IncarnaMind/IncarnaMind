import numpy as np
import pandas as pd
from scipy import stats

respondents = pd.read_csv(f"{DATA}/respondents.csv")

table = pd.crosstab(respondents["band"], respondents["channel"])
chi2, p, dof, expected = stats.chi2_contingency(table.to_numpy(), correction=False)
n = table.to_numpy().sum()
rows, columns = table.shape
phi2 = chi2 / n
# Bergsma's bias-corrected V, which some write instead of the plain one.
phi2_corrected = max(0.0, phi2 - (rows - 1) * (columns - 1) / (n - 1))
rows_corrected = rows - (rows - 1) ** 2 / (n - 1)
columns_corrected = columns - (columns - 1) ** 2 / (n - 1)

harbour = respondents[respondents["store"] == "Harbour Point"]
small = pd.crosstab(harbour["member"], harbour["recommends"]).to_numpy()
small_expected = stats.contingency.expected_freq(small)

result = {
    "chi2": float(chi2),
    "dof": int(dof),
    "chi_p": float(p),
    "cramers_v": [
        float(np.sqrt(phi2 / (min(rows, columns) - 1))),
        float(np.sqrt(phi2_corrected / (min(rows_corrected, columns_corrected) - 1))),
    ],
    "fisher_p": float(stats.fisher_exact(small, alternative="two-sided").pvalue),
    # Not scored: the rule holds for the whole table and fails at Harbour Point, and the
    # chi-square p-values Fisher's test replaces there, with and without Yates's correction.
    "min_expected": float(expected.min()),
    "small_min_expected": float(small_expected.min()),
    "small_chi_p": [
        float(stats.chi2_contingency(small, correction=False).pvalue),
        float(stats.chi2_contingency(small, correction=True).pvalue),
    ],
}
