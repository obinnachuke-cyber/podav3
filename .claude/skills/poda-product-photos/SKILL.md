---
name: poda-product-photos
description: Turn a folder of raw garment photos (HEIC or JPG) into a storefront-ready poda library: group photos by garment, rotate upright, remove backgrounds, straighten, centre on a 1600x2000 white 4:5 canvas, QC, and write inventory.csv. Use when the user drops a folder of clothing photos and wants them edited, cut out, put on white, organised into item folders, or prepared for the Admin mass upload (Supply, My inventory).
---

# poda product photos

Final product: `poda_inventory/NNN_brand_item/{originals,edited}` plus `inventory.csv`. It uploads as it is through Admin, Supply, My inventory: each item folder becomes one draft item and its first edited photo is the cover.

## Output contract

- One folder per garment: `NNN_brand_item_color`, for example `001_nike_hoodie_grey`.
- `originals/`: the untouched source files, copied. Never modify or delete originals.
- `edited/`: 1600x2000 PNG, garment centred with about 10% padding, on pure white.
- `edited/transparent/`: the same cutouts on transparent, for later use. Admin upload ignores this folder.
- Names: `01_front.png`, `02_back.png`, `03_detail.png`, `04_label.png`, `05_condition.png`, then `06_…` onward for extra angles. Skipped slots stay empty: do not renumber.
- Detail and label shots keep their background and are cropped 4:5, not cut out.
- `inventory.csv` columns: Item ID, Brand, Item name, Color, Number of photographs, Primary image filename, Editing status, Notes requiring manual review.

## Rules

- Light retouching only. Never hide stains, holes, pilling or wear. Never invent details, logos or text.
- Flag uncertainty, do not guess. If a brand, size or model is not readable on a label, write "Not identified" and say why in the notes. A logo that is a company print or event merch is not the maker.
- Every photo must be upright: the top of the garment at the top.
- Garments laid at an angle get straightened to a vertical axis.
- Check every output image. Contact sheets first, then 100% zoom on edges of anything doubtful.

## Setup (once)

```powershell
pip install rembg onnxruntime pymatting opencv-python pillow pillow-heif truststore numpy
```

- Set `NUMBA_CACHE_DIR` to a writable folder on every run, otherwise the rembg import fails with a numba cache error.
- Model downloads behind the corporate proxy fail with `CERTIFICATE_VERIFY_FAILED` unless `truststore.inject_into_ssl()` runs first. `pipeline.py` already does this. Never disable certificate checks.
- Models used: `isnet-general-use` and `birefnet-general-lite`. First run downloads them.

## Workflow

1. **Inventory the photos.** List the source folder. Skip files that are not garments (for example a skin close-up) and say so.
2. **Group by garment.** Look at the photos on contact sheets and group by garment: same item appears front, back, label, detail and alternate frames. Read labels to identify brand, size and care details. Record which source numbers belong to which item.
3. **Find the rotation of each photo.** Phones store HEIC with EXIF orientation, which `pipeline.py` applies first. Then give each photo a clockwise rotation (0, 90, 180, 270) that makes the garment top face up. Judge from the image, not the filename. Check a contact sheet of the rotated results: wrong guesses are common for labels and flat lays.
4. **Name the slots.** Per item decide which photo is front, back, label, detail, then alternates. Front first: it becomes the cover.
5. **Write the manifest.** See below. Pick a `mode` per item.
6. **Run the pipeline.**
   ```powershell
   $env:NUMBA_CACHE_DIR = "C:\temp\numba"; python scripts\pipeline.py manifest.json
   ```
   Pass folder substrings after the manifest to rerun only some items: `python scripts\pipeline.py manifest.json 011 012`.
7. **QC.** Build contact sheets: `python scripts\contact_sheet.py <out> sheet.jpg 001 002 003`. View them. Fix problems by changing the item's `mode`, `deskew` or `no_deskew` and rerunning just that item. Zoom to 100% on edges of dark, white and striped garments.
8. **Write inventory.csv** with `python scripts\make_inventory_csv.py manifest.json`. It adds notes for photos cut off by the original frame and for missing back or label shots. Items with an unidentified brand are marked "Edited: review recommended".
9. **Hand over.** Tell the user the item count, the weak cutouts, every brand or size that is unidentified, anything that may be new with tags. Then they upload the folder in Admin, Supply, My inventory.

## Manifest

See `references/example-manifest.json`, a real 21-item batch.

```json
{
  "src": "C:/path/to/photos",
  "out": "C:/path/to/poda_inventory",
  "file_pattern": "IMG_0{n}.HEIC",
  "rotations": { "184": 90, "185": 0 },
  "no_deskew": [220, 236],
  "items": {
    "001_nike_hoodie_grey": {
      "mode": "model",
      "deskew": true,
      "photos": [["01_front", 186, "cut"], ["02_back", 187, "cut"], ["04_label", 188, "crop"]],
      "meta": { "brand": "Nike (label and swoosh)", "name": "Full-zip hoodie", "color": "Heather grey", "notes": "Label reads XL." }
    }
  }
}
```

- `photos`: `[slot, source number, kind]`. `cut` removes the background. `crop` keeps it and crops 4:5.
- `rotations`: clockwise degrees per source number.
- `no_deskew`: photos where straightening misfires, usually asymmetric layouts such as arms spread unevenly.

## Modes

| mode | use for | how |
|---|---|---|
| `model` | light or mid-tone garments, most pants and jeans, caps | BiRefNet mask |
| `isnet` | when BiRefNet picks up a foot or sock, for example tan pants | ISNet mask |
| `dark` | black, navy, dark green garments, striped jackets | ISNet plus a colour mask (dark or saturated pixels), which recovers white and cream stripes the model drops |
| `dark2` | charcoal or mid-dark garments with holes in `dark` | same, with a looser darkness threshold |
| `sat` | saturated red, blue, green garments | ISNet plus a saturation mask |
| `white` | white on a white sheet | ISNet and BiRefNet joined, gaps closed, holes filled |

## How the pipeline works

- Two passes: a coarse mask on a 1280 px copy finds the garment, then the crop is masked at up to 2000 px.
- A white balance from the bright sheet pixels, clamped to plus or minus 8%, neutralises colour cast.
- Components the model does not back are dropped. This removes carpet and feet.
- `pymatting` estimates the true foreground colour at edges, which removes the white halo.
- Straightening searches plus or minus 25 degrees for the best left-right mirror match and applies it only when the angle is at least 1 degree and the gain is clear. Caps are not straightened.
- Each cut image is flagged `touches_frame` when the garment was cut off by the original photo edge. Those cannot reach full padding, and `inventory.csv` notes them.

## Known weak spots

- White garment on a white sheet is the worst case. Expect ragged edges and check at 100%.
- Fine threads, frayed hems and drawstring tips are partly lost.
- Photos with sleeves or hems outside the frame cannot be fixed by editing: reshoot.
- Brand cannot be read without a label shot. Ask for one rather than guessing.
