import pandas as pd


def read(name):
    frame = pd.read_csv(f"{DATA}/{name}", parse_dates=["date"])
    frame["cents"] = (frame["amount"] * 100).round().astype("int64")
    return frame


ledger = read("ledger.csv")
bank = read("bank.csv")
# Each amount is on each side at most once, so the join on it gives every candidate pair.
assert ledger["cents"].is_unique and bank["cents"].is_unique
pairs = ledger.reset_index().merge(bank.reset_index(), on="cents", suffixes=("_ledger", "_bank"))
apart = (pairs["date_ledger"] - pairs["date_bank"]).abs().dt.days
matched = pairs[apart <= 3]
near_misses = pairs[apart > 3]

ledger_left = ledger.drop(index=matched["index_ledger"])
bank_left = bank.drop(index=matched["index_bank"])
difference = int(ledger["cents"].sum() - bank["cents"].sum())
assert difference == int(ledger_left["cents"].sum() - bank_left["cents"].sum())

result = {
    "matched": int(len(matched)),
    "ledger_unmatched_count": int(len(ledger_left)),
    "ledger_unmatched_sum": int(ledger_left["cents"].sum()) / 100,
    "bank_unmatched_count": int(len(bank_left)),
    "bank_unmatched_sum": int(bank_left["cents"].sum()) / 100,
    "difference": difference / 100,
    "near_misses": int(len(near_misses)),
    "near_miss_days": sorted(int(days) for days in apart[apart > 3]),
}
