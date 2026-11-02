"""Runs one run_code job in IncarnaMind's own Python, in the OS sandbox (ADR-0025).

The code runs through the helper Analyses run through (incarnamind.py), with the
same figure(), result(), step() and chart(), the same seeds and no clock. It reads
the copied Documents from ../inputs, and read_table(name, sheet) gives a sheet's
rows as IncarnaMind read them from that copy, indexed by their row number in the
sheet, named "row", so figure() can name the cells and IncarnaMind can work the
figure out again from them. What the run came to is written to the result file
the job names, also when the code fails.
"""

import ast
import json
import os
import sys

# In the OS sandbox the folders above the run's can't be read, and getcwd() reads them to find
# its own path: Python is told its folder instead, kept in step with chdir.
_here = [os.environ["INCARNAMIND_WORKING_FOLDER"]]
_chdir = os.chdir


def _tracked_chdir(path):
    _chdir(path)
    if not isinstance(path, int):
        _here[0] = os.path.normpath(os.path.join(_here[0], os.fsdecode(path)))


os.chdir = _tracked_chdir
os.getcwd = lambda: _here[0]
os.getcwdb = lambda: os.fsencode(_here[0])

LIB = os.path.dirname(__file__)
sys.path.insert(0, LIB)

import incarnamind  # noqa: E402

with open(os.environ["INCARNAMIND_JOB"], encoding="utf-8") as file:
    JOB = json.load(file)
with open(os.path.join(LIB, "tables", "index.json"), encoding="utf-8") as file:
    TABLES = json.load(file)
INPUTS = JOB["inputsFolder"]
_read = []


def _named(name):
    given = os.path.basename(str(name))
    found = [table for table in TABLES if table["file"] == given]
    if not found:
        found = [table for table in TABLES if table["file"].lower() == given.lower()]
    return given, found


def read_table(name, sheet=None):
    """A sheet's or CSV file's rows as IncarnaMind read them, indexed by their row number in the sheet ("row")."""
    given, found = _named(name)
    files = sorted({table["file"] for table in TABLES})
    if not found:
        on_disk = sorted(os.listdir(INPUTS))
        if given in on_disk:
            raise ValueError(
                f"{given} isn't a sheet or CSV file IncarnaMind read as a table (it reads those up to "
                f"{JOB['tableMegabytes']} MB): open it from ../inputs/{given}, and give its figures with result(). "
                f"Tables: {', '.join(files) or 'none'}."
            )
        raise FileNotFoundError(f"No input is called {given!r}. Inputs: {', '.join(on_disk) or 'none'}.")
    sheets = [table["sheet"] for table in found]
    if sheet is None:
        table = found[0]
    else:
        matches = [table for table in found if table["sheet"] == sheet]
        if not matches:
            listed = ", ".join(repr(each) for each in sheets if each is not None)
            raise ValueError(f"{given} has no sheet {sheet!r}; its sheets are {listed}.")
        table = matches[0]
    with open(os.path.join(LIB, "tables", table["path"]), encoding="utf-8") as file:
        spec = json.load(file)
    frame = incarnamind._frame(spec)
    if spec["name"] not in _read:
        _read.append(spec["name"])
    return frame


def _draws(code):
    try:
        tree = ast.parse(code)
    except SyntaxError:
        return False
    for node in ast.walk(tree):
        if isinstance(node, ast.Import) and any(alias.name.split(".")[0] == "matplotlib" for alias in node.names):
            return True
        if isinstance(node, ast.ImportFrom) and (node.module or "").split(".")[0] == "matplotlib":
            return True
        if isinstance(node, ast.Attribute) and node.attr in incarnamind.PANDAS_PLOTS:
            return True
    return False


def main():
    if _draws(JOB["code"]) and JOB.get("font"):
        incarnamind.prepare_plots(JOB["font"])
    incarnamind.extra_names.update(read_table=read_table)
    done = json.loads(incarnamind.run(json.dumps({"code": JOB["code"], "inputs": [], "limits": JOB["limits"]})))
    done["read"] = _read
    with open(JOB["result"], "x", encoding="utf-8") as file:
        json.dump(done, file, allow_nan=False)


main()
