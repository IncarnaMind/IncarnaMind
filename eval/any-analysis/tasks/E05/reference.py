import pandas as pd

costs = pd.read_csv(f"{DATA}/costs.csv")
report_total = float(pd.read_csv(f"{DATA}/report_total.csv").set_index("name")["value"]["full_year_total"])

# In tenths of $000, as the report's amounts are, so each sum is exact.
tenths = (costs[["q1", "q2", "q3", "q4"]] * 10).round().astype("int64").sum(axis=1)
total = int(tenths.sum()) / 10
east = int(tenths[costs["region"] == "East"].sum()) / 10
assert total == report_total

result = {
    "rows": int(len(costs)),
    # In $000, as the report shows it, and in dollars: either is a right answer.
    "full_year_total": [total, total * 1000],
    "east_total": [east, east * 1000],
}
