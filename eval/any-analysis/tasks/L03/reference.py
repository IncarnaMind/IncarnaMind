import json

with open(f"{DATA}/terms.json") as file:
    terms = json.load(file)

result = {
    "value": terms["value"]["amount"],
    "late_rate": terms["lateRate"]["rate"],
    "cap": terms["cap"]["amount"],
    "notice_days": terms["notice"]["days"],
    "term_months": terms["term"]["months"],
}
