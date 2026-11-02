import numpy as np
import pandas as pd
from sklearn.ensemble import IsolationForest

transactions = pd.read_csv(f"{DATA}/transactions.csv")
features = transactions[["Hour", "Amount", "Items", "Distance km"]]


def top_twenty(model, points):
    scores = -model.fit(points).score_samples(points)
    return set(transactions["Transaction"].to_numpy()[np.argsort(-scores)[:20]])


# The question leaves the seed and the forest's size to the Answer: every one tried, on the raw
# features or their logs, ranks the same 20 transactions highest.
chosen = top_twenty(IsolationForest(random_state=0), features)
agree = all(
    top_twenty(IsolationForest(n_estimators=trees, random_state=seed), points) == chosen
    for seed in (1, 7, 42)
    for trees in (100, 300)
    for points in (features, np.log1p(features))
)

amounts = transactions["Amount"]
flagged = {
    ddof: set(transactions.loc[(amounts - amounts.mean()).abs() > 3 * amounts.std(ddof=ddof), "Transaction"])
    for ddof in (0, 1)
}
top = transactions[transactions["Transaction"].isin(chosen)]

result = {
    "top20": [{"key": row.Transaction, "amount": float(row.Amount)} for row in top.itertuples()],
    "rule_count": sorted({len(each) for each in flagged.values()}),
    "rule_catches": sorted({len(each & chosen) for each in flagged.values()}),
    # Not scored: whether every forest tried agrees on the 20.
    "forests_agree": int(agree),
}
