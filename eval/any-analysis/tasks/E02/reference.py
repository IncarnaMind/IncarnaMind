import json
import re

with open(f"{DATA}/cells.json") as file:
    book = json.load(file)

sales = book["sales"]
formulas = book["formulas"]
REFERENCE = re.compile(r"(?:([A-Za-z]+)!)?\$?([A-Z]{1,3})\$?(\d+)")


def column_number(letters):
    number = 0
    for letter in letters:
        number = number * 26 + ord(letter) - 64
    return number


def relative(address, formula):
    """The formula with each reference written as its offset from the cell, as R1C1 does."""
    sheet, cell = address.split("!")
    row, column = int(re.sub(r"\D", "", cell)), column_number(re.sub(r"\d", "", cell))

    def offset(match):
        return f"{match.group(1) or ''}R[{int(match.group(3)) - row}]C[{column_number(match.group(2)) - column}]"

    return REFERENCE.sub(offset, formula)


defects = []
for address, formula in formulas.items():
    sheet, cell = address.split("!")
    if "#REF!" in formula:
        defects.append(address)
    if any(
        (match.group(1) or sheet) == sheet and f"{match.group(2)}{match.group(3)}" == cell
        for match in REFERENCE.finditer(formula)
    ):
        defects.append(address)

# The month totals on row 8: one breaks the row's pattern.
row_eight = {address: relative(address, formula) for address, formula in formulas.items() if re.fullmatch(r"Sales![B-M]8", address)}
forms = list(row_eight.values())
pattern = max(set(forms), key=forms.count)
defects += [address for address, form in row_eight.items() if form != pattern]
defects += [f"Sales!{cell}" for cell in book["typed_as_text"]]

total = sum(sum(row) for row in sales)

result = {
    "defects": [{"key": address} for address in defects],
    "fixed_total": float(total),
    "fixed_average": total / len(book["regions"]),
    "saved_total": float(book["saved_total"]),
}
