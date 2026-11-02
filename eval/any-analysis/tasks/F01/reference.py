import pandas as pd


def cents(name):
    return (pd.read_csv(f"{DATA}/{name}").set_index("code") * 100).round().astype("int64").sum(axis=1)


# In whole cents, as the sheet's amounts are, so each sum is exact.
budget = cents("budget.csv")
actual = cents("actual.csv")
variance = actual - budget
worst = variance.sort_values(ascending=False, kind="stable").head(5)

result = {
    "worst": [
        {"key": code, "amount": int(amount) / 100, "share": float(amount / budget[code])}
        for code, amount in worst.items()
    ],
    "total_variance": int(variance.sum()) / 100,
    # The sixth most over budget, for checking the five stand clear of the rest.
    "sixth_amount": int(variance.sort_values(ascending=False, kind="stable").iloc[5]) / 100,
}
