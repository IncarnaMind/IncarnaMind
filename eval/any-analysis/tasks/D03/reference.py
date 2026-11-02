import pandas as pd

table = pd.read_csv(f"{DATA}/table3.csv").set_index("line")
lines = table.drop(index="Total (printed)")

result = {
    "sum_2024": int(lines["y2024"].sum()),
    "sum_2025": int(lines["y2025"].sum()),
    # Not scored: the Total row as printed, which both sums match.
    "printed_total": [int(each) for each in table.loc["Total (printed)"]],
}
