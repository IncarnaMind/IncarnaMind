# The schedule as Excel's PMT gives it: no rounding to the cent along the way.
import csv

with open(f"{DATA}/terms.csv", newline="") as file:
    terms = {row["term"]: float(row["value"]) for row in csv.DictReader(file)}

principal = terms["Principal"]
rate = terms["Annual interest rate"] / terms["Payments per year"]
count = int(terms["Term in years"] * terms["Payments per year"])
payment = principal * rate / (1 - (1 + rate) ** -count)

balance = principal
interest_paid = 0.0
for _ in range(count):
    interest = balance * rate
    interest_paid += interest
    balance -= payment - interest
assert abs(balance) < 1e-6
assert abs(interest_paid - (payment * count - principal)) < 1e-6

result = {
    "payments": count,
    "payment": payment,
    "total_interest": payment * count - principal,
}
