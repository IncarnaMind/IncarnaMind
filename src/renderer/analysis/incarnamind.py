"""What an Analysis's code runs with (ADR-0023), and how each run is made.

The code reads its inputs from `inputs`, reports with `step`, `result` and
`chart`, and runs in a namespace of its own, with the same seeds every time
and no clock. Before it runs, the numbers written in it are listed. What it
gives is cut to the limits each job brings, and goes back as JSON. Each job
runs in a fresh interpreter (../../main/analysis.ts).

The clock is taken away where code reaches it as a matter of course
(datetime, time, pandas' Timestamp and "today"), so an Analysis doesn't read
the date by accident. It is best-effort, not a boundary: code that means to
can still find the time.
"""

import ast
import builtins
import datetime as _datetime
import inspect
import io
import json
import linecache
import math
import numbers
import os
import random
import shutil
import sys
import time as _time
import traceback
import warnings
from collections.abc import Mapping

import numpy as np
import pandas as pd

FILENAME = "<analysis>"
WORKING_FOLDER = "/analysis"
# The numbers code writes for reasons other than data: counting, halves, percentages.
LEFT_OUT = (0, 1, 2, -1, 100)
CHART_KINDS = ("bar", "line", "pie", "scatter")
CLOCK_MESSAGE = (
    "An Analysis has no clock, so that it gives the same result every time it runs. "
    "Take the date as an input instead of reading today's."
)
# Calls that read the clock when given "now" or "today", in pandas and numpy's own parsers.
CLOCK_PARSERS = {
    "Timestamp",
    "to_datetime",
    "datetime64",
    "date_range",
    "bdate_range",
    "period_range",
    "Period",
    "DatetimeIndex",
}


class ClockError(RuntimeError):
    pass


def _from_analysis(depth):
    return sys._getframe(depth + 1).f_code.co_filename == FILENAME


def _without_clock(original, reads_clock_below):
    def guarded(*args, **kwargs):
        if len(args) + len(kwargs) < reads_clock_below and _from_analysis(1):
            raise ClockError(CLOCK_MESSAGE)
        return original(*args, **kwargs)

    guarded.__name__ = original.__name__
    guarded.__doc__ = original.__doc__
    return guarded


# A clock-free date or datetime type still answers `isinstance` and `issubclass` for the real one,
# which pandas and the code's own values are.
class _SameType(type):
    def __instancecheck__(cls, value):
        return isinstance(value, cls.__mro__[1])

    def __subclasscheck__(cls, other):
        return issubclass(other, cls.__mro__[1])


class _date(_datetime.date, metaclass=_SameType):
    __slots__ = ()

    @classmethod
    def today(cls):
        if _from_analysis(1):
            raise ClockError(CLOCK_MESSAGE)
        return super().today()


class _datetime_type(_datetime.datetime, metaclass=_SameType):
    __slots__ = ()

    @classmethod
    def now(cls, tz=None):
        if _from_analysis(1):
            raise ClockError(CLOCK_MESSAGE)
        return super().now(tz)

    @classmethod
    def today(cls):
        if _from_analysis(1):
            raise ClockError(CLOCK_MESSAGE)
        return super().today()

    @classmethod
    def utcnow(cls):
        if _from_analysis(1):
            raise ClockError(CLOCK_MESSAGE)
        return super().now(_datetime.timezone.utc).replace(tzinfo=None)


def _take_away_the_clock():
    _date.__name__ = _date.__qualname__ = "date"
    _datetime_type.__name__ = _datetime_type.__qualname__ = "datetime"
    _date.__module__ = _datetime_type.__module__ = "datetime"
    _datetime.date = _date
    _datetime.datetime = _datetime_type
    for name, reads_clock_below in (
        ("time", 1),
        ("time_ns", 1),
        ("localtime", 1),
        ("gmtime", 1),
        ("ctime", 1),
        ("asctime", 1),
        ("strftime", 2),
    ):
        setattr(_time, name, _without_clock(getattr(_time, name), reads_clock_below))
    for name in ("now", "today", "utcnow"):
        original = getattr(pd.Timestamp, name)

        def guarded(cls, *args, _original=original, **kwargs):
            if _from_analysis(1):
                raise ClockError(CLOCK_MESSAGE)
            return _original(*args, **kwargs)

        setattr(pd.Timestamp, name, classmethod(guarded))


def _seeded_default_rng(original):
    def default_rng(seed=None):
        return original(0 if seed is None else seed)

    default_rng.__doc__ = original.__doc__
    return default_rng


def _is_number(value):
    return isinstance(value, numbers.Real) and not isinstance(value, (bool, np.bool_))


def _text(value, limit):
    text = str(value)
    return text if len(text) <= limit else text[: limit - 1] + "…"


def _cell(value, limits):
    if value is None or value is pd.NaT or value is pd.NA:
        return None
    if isinstance(value, (bool, np.bool_)):
        return bool(value)
    if isinstance(value, numbers.Integral):
        return int(value)
    if _is_number(value):
        number = float(value)
        if math.isnan(number):
            return None
        if math.isinf(number):
            return "inf" if number > 0 else "-inf"
        return number
    if isinstance(value, (pd.Timestamp, _datetime.datetime, _datetime.date)):
        return value.isoformat()
    return _text(value, limits["cellCharacters"])


def _heading(name):
    if isinstance(name, tuple):
        return " / ".join(str(part) for part in name if str(part) != "")
    return str(name)


def _as_frame(value):
    if isinstance(value, pd.Series):
        return value.to_frame(name=value.name if value.name is not None else "value")
    return value


def _index_as_columns(frame):
    index = frame.index
    plain = (
        isinstance(index, pd.RangeIndex)
        and index.start == 0
        and index.step == 1
        and index.name is None
    )
    return frame if plain else frame.reset_index(allow_duplicates=True)


def _table(value, limits, rows_limit):
    frame = _index_as_columns(_as_frame(value))
    row_count, column_count = frame.shape
    kept = frame.iloc[:rows_limit, : limits["columns"]]
    return {
        "columns": [_text(_heading(name), limits["labelCharacters"]) for name in kept.columns],
        "rows": [
            [_cell(cell, limits) for cell in row]
            for row in kept.itertuples(index=False, name=None)
        ],
        "rowCount": int(row_count),
        "columnCount": int(column_count),
    }


def _name_of(value, what):
    if not isinstance(value, str) or not value.strip():
        raise TypeError(f"{what} needs a name: a short text such as 'total_revenue'.")
    return value.strip()


class NoSuchInput(KeyError):
    def __str__(self):
        return self.args[0]


class _Inputs(Mapping):
    def __init__(self, values):
        self._values = values

    def __getitem__(self, name):
        if name not in self._values:
            names = ", ".join(repr(each) for each in self._values) or "none"
            raise NoSuchInput(f"No input is named {name!r}. The inputs are: {names}.")
        value = self._values[name]
        # A copy each time: code that changes what it read leaves the next read as the sheet has it.
        return value.copy() if isinstance(value, pd.DataFrame) else value

    def __iter__(self):
        return iter(self._values)

    def __len__(self):
        return len(self._values)

    def __repr__(self):
        return f"inputs({', '.join(repr(each) for each in self._values)})"


class _Run:
    def __init__(self, limits):
        self.limits = limits
        self.steps = []
        self.results = []
        self.named = {}
        self.charts = []
        self.merges = []
        self.not_numbers = []
        self.cut = {
            "figures": 0,
            "tables": 0,
            "charts": 0,
            "steps": 0,
            "merges": 0,
            "notNumbers": 0,
            "literals": 0,
        }

    def keep(self, kind, items, item, count=None):
        if (len(items) if count is None else count) < self.limits[kind]:
            items.append(item)
            return True
        self.cut[kind] += 1
        return False


_run = None
inputs = _Inputs({})


def step(label, data):
    """Records a step of the analysis and how many rows and columns `data` has after it. Returns `data`."""
    label = _name_of(label, "step()")
    if isinstance(data, pd.DataFrame):
        rows, columns = data.shape
    elif isinstance(data, pd.Series):
        rows, columns = len(data), 1
    else:
        raise TypeError("step() takes a label and the DataFrame or Series after that step.")
    _run.keep(
        "steps",
        _run.steps,
        {"label": _text(label, _run.limits["labelCharacters"]), "rows": int(rows), "columns": int(columns)},
    )
    return data


def result(name, value, label=None, unit=None):
    """Gives a figure (a number) or a table (a DataFrame or Series) under `name`.

    For a percent figure, unit="%" takes a fraction: 0.081 shows as 8.1%.
    """
    name = _name_of(name, "result()")
    limits = _run.limits
    shown = {
        "name": _text(name, limits["labelCharacters"]),
        "label": _text(name if label is None else label, limits["labelCharacters"]),
        "unit": None if unit is None else _text(unit, limits["labelCharacters"]),
    }
    if isinstance(value, (pd.DataFrame, pd.Series)):
        kind = "tables"
        item = {"kind": "table", **shown, "table": _table(value, limits, limits["rows"])}
    elif _is_number(value):
        number = float(value)
        if math.isnan(number) or math.isinf(number):
            raise ValueError(
                f"result() got {number} for {name!r}, which is not a number it can give: "
                "often a division by zero or an empty selection."
            )
        kind = "figures"
        item = {"kind": "figure", **shown, "value": number}
    else:
        raise TypeError(
            f"result() takes a number or a table (a DataFrame or Series), not {type(value).__name__}."
        )
    if name in _run.named:
        _run.results[_run.named[name]] = item
        return value
    same = sum(1 for each in _run.results if each["kind"] == item["kind"])
    if _run.keep(kind, _run.results, item, same):
        _run.named[name] = len(_run.results) - 1
    return value


def chart(kind, data, x=None, y=None, title=None):
    """Draws `data` as a bar, line, pie or scatter chart: `x` the column along the axis, `y` the column or columns drawn."""
    if kind not in CHART_KINDS:
        raise ValueError(f"chart() draws {', '.join(CHART_KINDS)}, not {kind!r}.")
    if not isinstance(data, (pd.DataFrame, pd.Series)):
        raise TypeError("chart() takes the data as a DataFrame or Series.")
    frame = _index_as_columns(_as_frame(data))
    columns = [_heading(name) for name in frame.columns]
    frame = frame.set_axis(columns, axis=1)
    x = columns[0] if x is None else _heading(x)
    if y is None:
        y = [name for name in columns if name != x and pd.api.types.is_numeric_dtype(frame[name])]
    elif not isinstance(y, (list, tuple)):
        y = [y]
    y = [_heading(name) for name in y]
    for name in [x, *y]:
        if name not in columns:
            raise KeyError(f"chart() has no column {name!r}. The columns are: {', '.join(map(repr, columns))}.")
    limits = _run.limits
    _run.keep(
        "charts",
        _run.charts,
        {
            "kind": kind,
            "title": "" if title is None else _text(title, limits["labelCharacters"]),
            "x": x,
            "y": y,
            "table": _table(frame[[x, *y]], limits, limits["chartRows"]),
        },
    )


def _numbers_written(tree, code, limit):

    def number(node):
        return isinstance(node, ast.Constant) and type(node.value) in (int, float)

    def negated(node):
        return isinstance(node, ast.UnaryOp) and isinstance(node.op, ast.USub) and number(node.operand)

    def indices(node):
        if isinstance(node, ast.Constant) and type(node.value) is int:
            return [node]
        if negated(node) and type(node.operand.value) is int:
            return [node, node.operand]
        if isinstance(node, ast.Slice):
            return [found for part in (node.lower, node.upper, node.step) if part for found in indices(part)]
        if isinstance(node, ast.Tuple):
            return [found for element in node.elts for found in indices(element)]
        return []

    counting = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Subscript):
            counting.update(map(id, indices(node.slice)))
        elif isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id == "range":
            for argument in node.args:
                counting.update(map(id, indices(argument)))
    found = []
    inside = set()
    for node in ast.walk(tree):
        if negated(node):
            inside.add(id(node.operand))
            value = -node.operand.value
        elif number(node) and id(node) not in inside:
            value = node.value
        else:
            continue
        if id(node) in counting or any(value == left for left in LEFT_OUT):
            continue
        try:
            value = float(value)
        except OverflowError:
            continue
        if math.isfinite(value):
            text = ast.get_source_segment(code, node) or repr(value)
            found.append((node.lineno, node.col_offset, value, text))
    found.sort(key=lambda each: (each[0], each[1]))
    return [
        {"value": value, "line": line, "text": text} for line, _, value, text in found[:limit]
    ], max(0, len(found) - limit)


def _clock_parsed_at(tree):
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        callee = node.func.attr if isinstance(node.func, ast.Attribute) else getattr(node.func, "id", None)
        if callee not in CLOCK_PARSERS:
            continue
        for argument in [*node.args, *(keyword.value for keyword in node.keywords)]:
            if (
                isinstance(argument, ast.Constant)
                and isinstance(argument.value, str)
                and argument.value.strip().lower() in ("now", "today")
            ):
                return node.lineno
    return None


def _column(input_name, heading, cells, row_numbers):
    filled = [cell for cell in cells if cell is not None and cell != ""]
    count = sum(1 for cell in filled if _is_number(cell))
    if count == 0 or count * 2 < len(filled):
        return pd.Series(cells)
    values = []
    bad = []
    for offset, cell in enumerate(cells):
        if _is_number(cell):
            values.append(cell)
        else:
            values.append(math.nan)
            bad.append({"row": row_numbers[offset], "value": "" if cell is None else str(cell)})
    if bad:
        limits = _run.limits
        _run.keep(
            "notNumbers",
            _run.not_numbers,
            {
                "input": input_name,
                "column": _text(heading, limits["labelCharacters"]),
                "count": len(bad),
                "cells": [
                    {"row": each["row"], "value": _text(each["value"], limits["labelCharacters"])}
                    for each in bad[: limits["cellsListed"]]
                ],
            },
        )
    whole = not bad and all(isinstance(value, numbers.Integral) for value in values)
    return pd.Series(values, dtype="int64" if whole else "float64")


def _frame(spec):
    columns = [str(name) for name in spec["columns"]]
    rows = spec["rows"]
    row_numbers = spec.get("rowNumbers") or range(spec["firstRow"], spec["firstRow"] + len(rows))
    data = {}
    for index, heading in enumerate(columns):
        cells = [row[index] if index < len(row) else None for row in rows]
        data[index] = _column(spec["name"], heading, cells, row_numbers)
    frame = pd.DataFrame(data, index=pd.RangeIndex(len(rows)))
    frame.columns = columns
    return frame


_merge = pd.merge
_merge_signature = inspect.signature(_merge)


def _counted(left, right, args, kwargs):
    merged = _merge(left, right, *args, **kwargs)
    if _run is None or not _from_analysis(2):
        return merged
    bound = _merge_signature.bind(left, right, *args, **kwargs)
    how = bound.arguments.get("how", "inner")
    if how == "cross":
        return merged
    report = {
        "line": sys._getframe(2).f_lineno,
        "how": str(how),
        "leftRows": len(left),
        "rightRows": len(right),
        "rows": len(merged),
        "matched": None,
        "leftOnly": None,
        "rightOnly": None,
    }
    counting = dict(bound.arguments)
    counting.update(how="outer", indicator="_incarnamind_merge", validate=None, sort=False)
    try:
        sides = _merge(**counting)["_incarnamind_merge"].value_counts()
    except (KeyError, TypeError, ValueError) as error:
        # The merge's own keys worked; an outer merge on them may not (a key both sides name
        # "_incarnamind_merge"). The report then says its counts are unknown.
        warnings.warn(f"Couldn't count the rows the merge matched: {error}", stacklevel=3)
    else:
        report.update(
            matched=int(sides.get("both", 0)),
            leftOnly=int(sides.get("left_only", 0)),
            rightOnly=int(sides.get("right_only", 0)),
        )
    _run.keep("merges", _run.merges, report)
    return merged


def _merged(left, right, *args, **kwargs):
    return _counted(left, right, args, kwargs)


def _frame_merge(self, right, *args, **kwargs):
    return _counted(self, right, args, kwargs)


class _Printed(io.TextIOBase):
    def __init__(self, limit):
        self.parts = []
        self.size = 0
        self.limit = limit
        self.cut = False

    def writable(self):
        return True

    def write(self, text):
        if not isinstance(text, str):
            raise TypeError(f"write() takes text, not {type(text).__name__}")
        room = self.limit - self.size
        if room > 0:
            kept = text[:room]
            self.parts.append(kept)
            self.size += len(kept)
        if len(text) > max(room, 0):
            self.cut = True
        return len(text)

    def text(self):
        return "".join(self.parts)


def _error_of(error, limit):
    trace = error.__traceback__
    line = None
    start = None
    while trace is not None:
        if trace.tb_frame.f_code.co_filename == FILENAME:
            start = start or trace
            line = trace.tb_lineno
        trace = trace.tb_next
    if isinstance(error, SyntaxError) and error.filename == FILENAME:
        line = error.lineno
    summary = traceback.TracebackException(type(error), error, start)
    # The helper's own frames say nothing the code can act on: the line that called it does.
    summary.stack = traceback.StackSummary.from_list(
        [frame for frame in summary.stack if frame.filename != __file__]
    )
    text = "".join(summary.format()).strip()
    if len(text) > limit:
        text = "…\n" + text[-(limit - 2) :]
    return {"kind": "error", "message": text, "line": line}


_home = os.getcwd()
_environment = dict(os.environ)
_warning_filters = list(warnings.filters)
_numpy_errors = np.geterr()
_recursion = sys.getrecursionlimit()
_path = list(sys.path)


def _clean_up():
    random.seed(0)
    np.random.seed(0)
    np.seterr(**_numpy_errors)
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        # Every option but plotting's, whose reset looks for matplotlib, which isn't bundled.
        pd.reset_option(r"^(?!plotting\.)")
    warnings.filters[:] = _warning_filters
    sys.setrecursionlimit(_recursion)
    sys.path[:] = _path
    os.environ.clear()
    os.environ.update(_environment)
    os.chdir(_home)
    for folder in (WORKING_FOLDER, "/tmp"):
        shutil.rmtree(folder, ignore_errors=True)
        os.makedirs(folder, exist_ok=True)
    linecache.cache.pop(FILENAME, None)


def run(job_text):
    """Runs one job, as JSON, and gives back what it came to, as JSON."""
    try:
        return _run_job(json.loads(job_text))
    except Exception as error:
        message = f"The analysis couldn't be run: {type(error).__name__}: {error}"
        return json.dumps({"end": {"kind": "error", "message": message, "line": None}, "output": None})


def _run_job(job):
    global _run, inputs
    limits = job["limits"]
    code = job["code"]
    _clean_up()
    _run = _Run(limits)
    literals = []
    printed = _Printed(limits["printed"])
    try:
        tree = ast.parse(code, FILENAME)
        literals, _run.cut["literals"] = _numbers_written(tree, code, limits["literals"])
        clock = _clock_parsed_at(tree)
        if clock is not None:
            end = {"kind": "error", "message": f"ClockError: {CLOCK_MESSAGE}", "line": clock}
        else:
            values = {}
            for spec in job["inputs"]:
                values[spec["name"]] = _frame(spec) if spec["kind"] == "table" else spec["value"]
            inputs = _Inputs(values)
            module = sys.modules[__name__]
            namespace = {
                "__name__": "__main__",
                "__builtins__": builtins,
                "inputs": inputs,
                "step": step,
                "result": result,
                "chart": chart,
                "incarnamind": module,
                # Models write pd and np without importing them, as notebooks have them.
                "pd": pd,
                "np": np,
            }
            linecache.cache[FILENAME] = (len(code), None, code.splitlines(True), FILENAME)
            os.chdir(WORKING_FOLDER)
            stdout, stderr = sys.stdout, sys.stderr
            sys.stdout = sys.stderr = printed
            try:
                exec(compile(tree, FILENAME, "exec"), namespace)
            finally:
                sys.stdout, sys.stderr = stdout, stderr
            end = {"kind": "done"}
    except MemoryError:
        end = {"kind": "out-of-memory"}
    except BaseException as error:
        end = _error_of(error, limits["errorCharacters"])
    output = {
        "steps": _run.steps,
        "results": _run.results,
        "charts": _run.charts,
        "merges": _run.merges,
        "notNumbers": _run.not_numbers,
        "literals": literals,
        "printed": printed.text(),
        "cut": {**_run.cut, "printed": printed.cut},
    }
    _run = None
    inputs = _Inputs({})
    _clean_up()
    return json.dumps({"end": end, "output": output}, allow_nan=False)


_take_away_the_clock()
np.random.default_rng = _seeded_default_rng(np.random.default_rng)
_merged.__doc__ = _merge.__doc__
pd.merge = _merged
pd.DataFrame.merge = _frame_merge
os.makedirs(WORKING_FOLDER, exist_ok=True)
