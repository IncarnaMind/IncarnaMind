import numpy as np
import pandas as pd

amounts = pd.read_csv(f"{DATA}/claims.csv")["amount"].to_numpy()

# The question leaves the seed to the Answer: the interval's ends are their means over 40 seeds.
lows, highs = [], []
for seed in range(40):
    picks = np.random.default_rng(seed).integers(0, len(amounts), size=(10_000, len(amounts)))
    medians = np.median(amounts[picks], axis=1)
    low, high = np.percentile(medians, [2.5, 97.5])
    lows.append(low)
    highs.append(high)

result = {
    "median": float(np.median(amounts)),
    "ci_low": float(np.mean(lows)),
    "ci_high": float(np.mean(highs)),
    # Not scored: the ends' ranges over the seeds, which the tolerances cover, and the mean.
    "ci_low_range": [float(min(lows)), float(max(lows))],
    "ci_high_range": [float(min(highs)), float(max(highs))],
    "mean": float(amounts.mean()),
}
