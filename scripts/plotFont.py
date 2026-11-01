"""Makes resources/fonts/NotoSansSC-GB2312.otf, the font Analyses' plots draw Chinese with (#2346).

matplotlib's own fonts have no Chinese, so a plot with Chinese labels would show boxes. This
keeps, of Noto Sans SC Regular 2.004 (SIL Open Font License 1.1, no Reserved Font Name), the
6,763 characters of GB2312 with its punctuation and full-width forms, ASCII, Latin-1, general
punctuation and the CJK symbols, so names that use its less common characters draw too.
It needs fontTools 4.62.1, and the source font from
https://github.com/notofonts/noto-cjk/raw/Sans2.004/Sans/SubsetOTF/SC/NotoSansSC-Regular.otf:

    python3 scripts/plotFont.py NotoSansSC-Regular.otf resources/fonts/NotoSansSC-GB2312.otf
"""

import hashlib
import sys

from fontTools import subset

SOURCE_SHA256 = "faa6c9df652116dde789d351359f3d7e5d2285a2b2a1f04a2d7244df706d5ea9"


def gb2312(first_row, last_row):
    """The characters of GB2312's rows `first_row` to `last_row`."""
    found = []
    for row in range(first_row, last_row + 1):
        for cell in range(1, 95):
            try:
                found.append(bytes([0xA0 + row, 0xA0 + cell]).decode("gb2312"))
            except UnicodeDecodeError:
                pass
    return found


def characters():
    # Rows 1 and 3 are GB2312's punctuation and full-width forms; 16 to 87 its two levels of hanzi.
    kept = gb2312(1, 1) + gb2312(3, 3) + gb2312(16, 87)
    ranges = [(0x20, 0x7E), (0xA0, 0xFF), (0x2010, 0x2027), (0x3000, 0x303F), (0xFF01, 0xFF5E)]
    kept += [chr(code) for first, last in ranges for code in range(first, last + 1)]
    kept += ["‰", "℃", "№"]
    return "".join(sorted(set(kept)))


def main(source, output):
    with open(source, "rb") as file:
        digest = hashlib.sha256(file.read()).hexdigest()
    if digest != SOURCE_SHA256:
        sys.exit(f"{source} has SHA-256 {digest}, not Noto Sans SC Regular 2.004's {SOURCE_SHA256}.")
    options = subset.Options()
    options.layout_features = ["*"]
    options.hinting = False
    font = subset.load_font(source, options)
    subsetter = subset.Subsetter(options)
    subsetter.populate(text=characters())
    subsetter.subset(font)
    subset.save_font(font, output, options)


if __name__ == "__main__":
    main(*sys.argv[1:3])
