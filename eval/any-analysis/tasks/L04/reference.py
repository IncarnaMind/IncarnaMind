import csv
from collections import Counter

with open(f"{DATA}/comments.csv", newline="") as file:
    counts = Counter(row["theme"] for row in csv.DictReader(file))

result = {"themes": [{"key": theme, "count": count} for theme, count in counts.most_common()]}
