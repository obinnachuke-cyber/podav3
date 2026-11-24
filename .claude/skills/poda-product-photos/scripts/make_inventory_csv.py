"""Write inventory.csv from the manifest's per-item meta and the pipeline's report.json.
Usage: python make_inventory_csv.py manifest.json   (report.json sits next to the manifest)
Flags frame-cut shots and missing back/label shots automatically. Never invents brand or size:
put "Not identified" in meta.brand when it cannot be read.
"""
import csv, json, os, sys
mp = sys.argv[1]
M = json.load(open(mp, encoding="utf-8"))
rep = json.load(open(os.path.join(os.path.dirname(os.path.abspath(mp)), "report.json")))
rows = []
for folder, it in M["items"].items():
    meta = it["meta"]; slots = [p[0] for p in it["photos"]]
    flagged = [s for s, n, k in it["photos"] if k == "cut" and rep.get(f"{folder}/{s}", {}).get("touches_frame")]
    missing = [x for x in ("02_back", "04_label") if x not in slots]
    extra = []
    if flagged: extra.append("Garment cut by original photo frame: " + ", ".join(flagged) + ".")
    if missing: extra.append("No " + " or ".join(missing) + " photographed.")
    review = "Not identified" in meta["brand"] or meta.get("review", False)
    rows.append([folder[:3], meta["brand"], meta["name"], meta["color"], len(slots), "01_front.png",
                 "Edited: review recommended" if review else "Edited: ready", " ".join([meta["notes"]] + extra)])
with open(os.path.join(M["out"], "inventory.csv"), "w", newline="", encoding="utf-8-sig") as f:
    w = csv.writer(f)
    w.writerow(["Item ID", "Brand", "Item name", "Color", "Number of photographs", "Primary image filename", "Editing status", "Notes requiring manual review"])
    w.writerows(rows)
print("wrote", len(rows), "rows")
