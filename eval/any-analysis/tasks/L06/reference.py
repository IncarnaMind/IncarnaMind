import pandas as pd

takings = pd.read_csv(f"{DATA}/takings.csv")

result = {
    "total": int(takings["cents"].sum()) / 100,
    "rows": len(takings),
    "formats": takings["format"].value_counts().sort_index().tolist(),
}
