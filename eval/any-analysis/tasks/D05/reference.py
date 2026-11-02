import pandas as pd

workbook = pd.read_csv(f"{DATA}/workbook.csv").set_index("region")
deck = pd.read_csv(f"{DATA}/deck.csv").set_index("region")

stale = []
for region in workbook.index:
    for column in workbook.columns:
        if deck.loc[region, column] != workbook.loc[region, column]:
            stale.append(
                {
                    "key": region,
                    "column": column,
                    "deck": float(deck.loc[region, column]),
                    "workbook": float(workbook.loc[region, column]),
                }
            )

result = {"stale": stale}
