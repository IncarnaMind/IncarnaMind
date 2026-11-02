import pandas as pd

orders = pd.read_csv(f"{DATA}/orders.csv", dtype={"customer": str}, keep_default_na=False)
customers = pd.read_csv(f"{DATA}/customers.csv", dtype={"customer": str}, keep_default_na=False)


def key(ids):
    return ids.str.strip().str.upper()


customers["key"] = key(customers["customer"])
orders["key"] = key(orders["customer"])

repeated = customers[customers.duplicated("key", keep=False)].sort_values("sheet_row")
duplicates = [
    {"key": name, "first_row": int(rows.iloc[0]), "second_row": int(rows.iloc[1])}
    for name, rows in repeated.groupby("key", sort=False)["sheet_row"]
]
assert all(len(rows) == 2 for _, rows in repeated.groupby("key")["sheet_row"])

joined = orders.merge(customers.drop_duplicates("key", keep="first"), on="key", how="inner")
orphans = orders[~orders["key"].isin(customers["key"])]
exact = orders["customer"].isin(customers["customer"])

result = {
    "duplicates": duplicates,
    "joined": int(len(joined)),
    "orphan_count": int(len(orphans)),
    "orphan_amount": int((orphans["amount"] * 100).round().sum()) / 100,
    # What a join on the IDs as written gives, for checking it stays apart.
    "joined_as_written": int(exact.sum()),
}
