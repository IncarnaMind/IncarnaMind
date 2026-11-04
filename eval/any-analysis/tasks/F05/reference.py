import numpy as np
import pandas as pd

invoices = pd.read_csv(f"{DATA}/invoices.csv", parse_dates=["due"])
receipts = pd.read_csv(f"{DATA}/receipts.csv", parse_dates=["date"])
as_at = pd.Timestamp(pd.read_csv(f"{DATA}/parameters.csv").set_index("name")["value"]["as_at"])


def cents(amounts):
    return (amounts * 100).round().astype("int64")


# Receipts dated after the ageing date are in the export but not yet received as at it.
received = receipts[receipts["date"] <= as_at].assign(cents=lambda frame: cents(frame["amount"]))
paid = received.groupby("invoice")["cents"].sum()
invoices["balance"] = cents(invoices["amount"]) - invoices["invoice"].map(paid).fillna(0).astype("int64")
assert (invoices["balance"] >= 0).all()

past_due = (as_at - invoices["due"]).dt.days
invoices["bucket"] = np.select(
    [past_due <= 30, past_due <= 60, past_due <= 90], ["days_0_30", "days_31_60", "days_61_90"], "over_90"
)
open_items = invoices[invoices["balance"] > 0]
table = open_items.pivot_table(
    index="customer", columns="bucket", values="balance", aggfunc="sum", fill_value=0
).reindex(columns=["days_0_30", "days_31_60", "days_61_90", "over_90"], fill_value=0)

result = {
    "ageing": [
        {"key": customer, **{bucket: int(value) / 100 for bucket, value in row.items()}}
        for customer, row in table.sort_index().iterrows()
    ],
    "total": int(open_items["balance"].sum()) / 100,
    "open_invoices": int(len(open_items)),
    "receipts_after_as_at": int((receipts["date"] > as_at).sum()),
}
