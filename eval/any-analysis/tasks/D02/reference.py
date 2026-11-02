import pandas as pd

payments = pd.read_csv(f"{DATA}/payments.csv")

result = {
    "payment_count": int(len(payments)),
    "payments_total": round(float(payments["amount"].sum()), 2),
}
