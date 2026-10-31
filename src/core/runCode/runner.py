"""Runs a run_code snippet (spike, docs/adr/0025): reads its inputs, records its results.

The snippet is lib/main.py. It reads the copied Documents with read_table, which
numbers each row as its sheet does (the headings are row 1), and gives figures
with result(). A figure that names the column of rows it came from (of=) and how
(how=) can be worked out again by the app from the Document's own cells; any
other figure is shown with its code, unchecked. What it gives is written to
out/results.json when it ends, also when it fails.
"""

import json
import os
import runpy
import sys
import traceback

LIB = os.path.dirname(os.path.abspath(__file__))
INPUTS = os.environ["INCARNAMIND_INPUTS"]
OUT = os.environ["INCARNAMIND_OUT"]
SITE = os.environ.get("INCARNAMIND_SITE")
if SITE:
    sys.path.insert(0, SITE)
HOW = ("sum", "mean", "min", "max", "count")
_figures = []
_tables = []


def read_table(name, sheet=None):
    """An input's rows as a DataFrame whose index is each row's number in its sheet."""
    import pandas as pd

    base = os.path.basename(name)
    path = os.path.join(INPUTS, base)
    if base.lower().endswith((".xlsx", ".xlsm")):
        frame = pd.read_excel(path, sheet_name=sheet or 0)
    else:
        frame = pd.read_csv(path)
    frame.index = pd.RangeIndex(2, 2 + len(frame), name="row")
    frame.attrs["input"] = base
    frame.attrs["sheet"] = sheet
    return frame


def result(name, value, label=None, unit=None, of=None, how=None):
    """A figure for the Answer; of= the column it was worked out from, how= sum, mean, min, max or count."""
    figure = {"name": str(name), "label": str(label or name), "unit": unit, "value": float(value)}
    if of is not None:
        import pandas as pd

        if not isinstance(of, pd.Series) or "input" not in of.attrs or how not in HOW:
            raise ValueError(
                "of= takes a column of rows read with read_table, and how= one of " + ", ".join(HOW)
            )
        figure["of"] = {
            "input": of.attrs["input"],
            "sheet": of.attrs.get("sheet"),
            "column": str(of.name),
            "rows": [int(row) for row in of.index],
            "how": how,
        }
    _figures.append(figure)


def table(name, frame):
    """A table for the Answer, written to out/<name>.csv."""
    file = f"{name}.csv"
    frame.to_csv(os.path.join(OUT, file))
    _tables.append({"name": str(name), "file": file, "rows": int(len(frame))})


def _versions():
    from importlib import metadata

    found = {}
    for name in ("numpy", "pandas", "scipy", "statsmodels", "scikit-learn", "matplotlib"):
        try:
            found[name] = metadata.version(name)
        except metadata.PackageNotFoundError:
            pass
    return {"python": sys.version.split()[0], "packages": found}


def main():
    error = None
    try:
        runpy.run_path(
            os.path.join(LIB, "main.py"),
            init_globals={"read_table": read_table, "result": result, "table": table},
            run_name="__main__",
        )
    except SystemExit as stop:
        if stop.code not in (None, 0):
            error = f"exited with {stop.code}"
    except BaseException:
        error = traceback.format_exc(limit=-3)
        traceback.print_exc()
    with open(os.path.join(OUT, "results.json"), "w", encoding="utf-8") as file:
        json.dump({"figures": _figures, "tables": _tables, "versions": _versions(), "error": error}, file)
    sys.exit(1 if error else 0)


main()
