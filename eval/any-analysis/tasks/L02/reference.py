import re

EXCEPTION = re.compile(r"^((?:\w+\.)+\w+(?:Exception|Error)): (.*)$")


def normalised(message):
    message = re.sub(r"/\S+", "<path>", message)
    return re.sub(r"\d+", "<n>", message)


seen = {}
with open(f"{DATA}/app.log") as file:
    for number, line in enumerate(file, start=1):
        match = EXCEPTION.match(line.rstrip("\n"))
        if not match:
            continue
        name, message = match.groups()
        signature = (name, normalised(message))
        entry = seen.setdefault(signature, {"count": 0, "first": number, "last": number})
        entry["count"] += 1
        entry["last"] = number

rows = sorted(seen.items(), key=lambda item: -item[1]["count"])
result = {
    "signatures": len(seen),
    "errors": [{"key": name.rsplit(".", 1)[1], **entry} for (name, _), entry in rows],
}
