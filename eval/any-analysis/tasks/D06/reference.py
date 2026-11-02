import pandas as pd

summary = pd.read_csv(f"{DATA}/summary.csv").set_index("line")
claimed = float(pd.read_csv(f"{DATA}/claim.csv")["claimed_growth"].iloc[0])

result = {
    "table_growth": float(summary.loc["Revenue", "y2025"] / summary.loc["Revenue", "y2024"] - 1),
    "claimed_growth": claimed,
}
