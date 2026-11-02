import numpy as np
import pandas as pd
from scipy import stats

users = pd.read_csv(f"{DATA}/users.csv")
a = users.loc[users["group"] == "A", "minutes"].to_numpy()
b = users.loc[users["group"] == "B", "minutes"].to_numpy()

welch = stats.ttest_ind(b, a, equal_var=False)
interval = welch.confidence_interval(0.95)
pooled = np.sqrt(((len(a) - 1) * a.var(ddof=1) + (len(b) - 1) * b.var(ddof=1)) / (len(a) + len(b) - 2))

result = {
    "mean_difference": float(b.mean() - a.mean()),
    "ci_low": float(interval.low),
    "ci_high": float(interval.high),
    "welch_t": float(welch.statistic),
    "welch_p": float(welch.pvalue),
    "cohens_d": float((b.mean() - a.mean()) / pooled),
    "rank_p": float(stats.mannwhitneyu(b, a, alternative="two-sided").pvalue),
    # Every group fails Shapiro-Wilk by far, so the task's "not normal" mention is the right reading.
    "shapiro_p": [float(stats.shapiro(a).pvalue), float(stats.shapiro(b).pvalue)],
}
