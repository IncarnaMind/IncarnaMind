import pandas as pd

budget = pd.read_csv(f"{DATA}/budget.csv")
stated = float(pd.read_csv(f"{DATA}/stated.csv")["stated_external"].iloc[0])

result = {
    "internal_sum": int(budget["internal"].sum()),
    "external_sum": int(budget["external"].sum()),
    # Not scored: the total the text states, which the external column matches.
    "stated_external": stated,
}
