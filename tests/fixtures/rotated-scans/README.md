# Rotated scan fixtures

`rotated.pdf` and `upright.pdf` are the matched two-page reproduction from #1819. Their decoded page images are identical between the files; only page 2's PDF rotation changes. Page 2 of `rotated.pdf` has `/Rotate 90`. Both files are raster-only, with no text layer.

The visible current worksheet on page 2 contains glass beads `0.075 kg × 2 = 0.150 kg`, control weights `0.050 kg × 2 = 0.100 kg`, and total/limit `0.250 kg`, followed by `最大载荷：0.250千克` and `状态：当前版本`. Before the orientation fix, real OCR read both quantities as `N` and started page 2 at its footer.

SHA-256:

- `rotated.pdf`: `05296301389e7060e89698147e4f7eb7bcc4035f677a60e276921297e9bf7d91`
- `upright.pdf`: `13e8ee70bf920a177e52fb55053afb7a0959f841f5b85ec562a40d4632ad658f`
