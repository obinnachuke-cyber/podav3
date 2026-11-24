"""Contact sheet of edited images for visual QC.
Usage: python contact_sheet.py <out_dir> <sheet.jpg> [folder-prefix ...]
Look at the sheet, then zoom to 100% on edges of anything suspicious.
"""
import os, sys, glob
from PIL import Image, ImageDraw


def sheet(root, folders, out, cols=5, w=320):
    tiles = []
    for d in folders:
        for f in sorted(glob.glob(f"{root}/{d}/edited/*.png")):
            im = Image.open(f).convert("RGB").resize((w, int(w * 1.25)))
            c = Image.new("RGB", (w, int(w * 1.25) + 16), (110, 110, 110)); c.paste(im, (0, 16))
            ImageDraw.Draw(c).text((3, 2), f"{d[:3]} {os.path.basename(f)[:-4]}", fill=(255, 255, 0)); tiles.append(c)
    rows = (len(tiles) + cols - 1) // cols; th = tiles[0].height
    sh = Image.new("RGB", (cols * w, rows * th), (60, 60, 60))
    for i, t in enumerate(tiles):
        sh.paste(t, ((i % cols) * w, (i // cols) * th))
    sh.save(out, quality=85)


if __name__ == "__main__":
    root, out, pre = sys.argv[1], sys.argv[2], sys.argv[3:]
    fs = [d for d in sorted(os.listdir(root)) if os.path.isdir(f"{root}/{d}") and (not pre or any(d.startswith(p) for p in pre))]
    sheet(root, fs, out)
