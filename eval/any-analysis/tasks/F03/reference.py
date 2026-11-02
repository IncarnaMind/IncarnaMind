# The loan's schedule as Excel's PMT and IPMT give it: no rounding to the cent along the way.
import csv

with open(f"{DATA}/terms.csv", newline="") as file:
    terms = {row["term"]: float(row["value"]) for row in csv.DictReader(file)}

principal = terms["Principal"]
rate = terms["Annual interest rate"] / terms["Payments per year"]
count = int(terms["Term in years"] * terms["Payments per year"])
extra = terms["Extra monthly payment"]

payment = principal * rate / (1 - (1 + rate) ** -count)
total_interest = payment * count - principal

balance = principal
month = 0
interest_with_extra = 0.0
while balance > 1e-9:
    month += 1
    interest = balance * rate
    interest_with_extra += interest
    balance -= min(balance, payment + extra - interest)

result = {
    "payment": payment,
    "first_interest": principal * rate,
    "total_interest": total_interest,
    "payoff_month": month,
    "interest_saved": total_interest - interest_with_extra,
}
