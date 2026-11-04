import re
from collections import defaultdict

import numpy as np

LINE = re.compile(r'\[(\d\d)/(\w{3})/(\d{4}):(\d\d):\d\d:\d\d [^\]]+\] "(\w+) (\S+) [^"]*" (\d{3}) \d+ (\d+)$')

total = 0
errors = 0
hours = defaultdict(lambda: [0, 0])
times = defaultdict(list)
with open(f"{DATA}/access.log") as file:
    for line in file:
        match = LINE.search(line.rstrip("\n"))
        day, month, year, hour, method, path, status, ms = match.groups()
        failed = status.startswith("5")
        total += 1
        errors += failed
        slot = hours[f"{year}-{month}-{day} {hour}:00"]
        slot[0] += 1
        slot[1] += failed
        times[f"{method} {path}"].append(int(ms))

spike, (requests, failures) = max(hours.items(), key=lambda item: item[1][1] / item[1][0])
p95 = sorted(((float(np.percentile(values, 95)), key) for key, values in times.items()), reverse=True)

result = {
    "error_share": errors / total,
    "spike_hour": spike,
    "spike_rate": failures / requests,
    "slowest": [{"key": key.split(" ", 1)[1], "p95": value} for value, key in p95[:10]],
}
