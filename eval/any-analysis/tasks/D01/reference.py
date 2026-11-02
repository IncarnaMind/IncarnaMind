import pandas as pd

statement = pd.read_csv(f"{DATA}/statement.csv").set_index("line")
revenue = statement.loc["Revenue"]

result = {
    "revenue_growth": float(revenue["y2025"] / revenue["y2024"] - 1),
    "gross_margin": float(statement.loc["Gross profit", "y2025"] / revenue["y2025"]),
    "operating_margin": float(statement.loc["Operating profit", "y2025"] / revenue["y2025"]),
}
