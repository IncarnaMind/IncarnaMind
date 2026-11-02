import pandas as pd

budget = pd.read_csv(f"{DATA}/budget.csv").set_index("code").sum(axis=1)
actual = pd.read_csv(f"{DATA}/actual.csv").set_index("code").sum(axis=1)
variance = actual - budget
share = variance / budget
worst = variance.sort_values(ascending=False).head(5)

result = {
    "worst": [
        {"key": code, "amount": float(amount), "share": float(share[code])}
        for code, amount in worst.items()
    ],
    "total_variance": float(variance.sum()),
    # The sixth most over budget, for checking the five stand clear of the rest.
    "sixth_amount": float(variance.sort_values(ascending=False).iloc[5]),
}
