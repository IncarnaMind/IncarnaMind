import json
import re

with open(f"{DATA}/formulas.json") as file:
    cells = json.load(file)

# Cell references (with their sheet, ranges and $ signs) go first, so their row numbers aren't read as numbers.
REFERENCE = re.compile(r"(?:[A-Za-z_][A-Za-z0-9_]*!)?\$?[A-Z]{1,3}\$?\d+")
NUMBER = re.compile(r"(?<![A-Za-z_])\d+(?:\.\d+)?(?:[eE][+-]?\d+)?")


def typed_numbers(formula):
    return [float(text) for text in NUMBER.findall(REFERENCE.sub(" ", formula)) if float(text) not in (0, 1)]


constants = []
for cell in cells:
    for number in typed_numbers(cell["formula"]):
        constants.append({"key": f"{cell['sheet']}!{cell['cell']}", "constant": number})

values = {f"{cell['sheet']}!{cell['cell']}": cell["value"] for cell in cells}

result = {
    "constants": constants,
    "constant_count": len(constants),
    "headline_npv": float(values["Summary!B4"]),
    "formula_cells": len(cells),
}
