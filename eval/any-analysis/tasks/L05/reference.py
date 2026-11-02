import pandas as pd

messages = pd.read_csv(f"{DATA}/messages.csv")
counts = messages["from"].value_counts()
hours = pd.to_datetime(messages["at"], unit="ms", utc=True).dt.hour.value_counts()
top = counts.index[0]
replies = messages[(messages["from"] == top) & messages["reply_to_at"].notna()]

result = {
    "top_senders": [{"key": sender, "count": int(count)} for sender, count in counts.head(3).items()],
    "busiest_hour": int(hours.idxmax()),
    "median_reply_minutes": float(((replies["at"] - replies["reply_to_at"]) / 60_000).median()),
}
