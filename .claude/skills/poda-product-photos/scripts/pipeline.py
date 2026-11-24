"""poda product photo pipeline (manifest driven).
Photos -> upright -> cutout (model + colour mask) -> straighten -> 1600x2000 on white.
Close-ups (label/detail) keep their background and get a 4:5 crop. Originals are copied, never modified.

Usage:  NUMBA_CACHE_DIR=<writable dir> python pipeline.py manifest.json [folder-substring ...]
See SKILL.md for the manifest format and the modes.
"""
import os, sys, shutil, json, math
import truststore; truststore.inject_into_ssl()   # corporate proxy: use the Windows cert store for model downloads
import numpy as np
import cv2
from PIL import Image, ImageOps
import pillow_heif
pillow_heif.register_heif_opener()
from rembg import remove, new_session
from pymatting import estimate_foreground_ml

W, H, PAD = 1600, 2000, 0.10
M = {}          # the loaded manifest
ROT = {}        # image number -> clockwise degrees to make it upright
NO_DESKEW = set()


def src_path(n):
    return os.path.join(M["src"], M["file_pattern"].format(n=n))


_SESS = {}


def sess(name):
    if name not in _SESS:
        _SESS[name] = new_session(name)
    return _SESS[name]



def load_upright(n):
    im = ImageOps.exif_transpose(Image.open(src_path(n))).convert("RGB")
    r = ROT[n]
    return {0: im, 90: im.transpose(Image.ROTATE_270), 180: im.transpose(Image.ROTATE_180), 270: im.transpose(Image.ROTATE_90)}[r]


def wb_gains(rgb_small):
    """White-sheet neutralising gains, clamped to +-8%."""
    a = rgb_small.astype(np.float32)
    lum, sat = a.mean(2), a.max(2) - a.min(2)
    m = (lum > np.percentile(lum, 70)) & (sat < 40)
    if m.sum() < 500:
        return np.ones(3, np.float32)
    mean = a[m].mean(0)
    return np.clip(mean.mean() / mean, 0.92, 1.08)


def colour_mask(rgb, mode):
    """Recovers white/cream stripes and tones the model drops: dark or saturated pixels are garment."""
    if mode in ("model", "isnet", "white"):
        return None
    a = rgb.astype(np.int16)
    lum, sat = a.mean(2), a.max(2) - a.min(2)
    thr = {"dark": 95, "dark2": 125}.get(mode)
    m = ((lum < thr) | (sat > 70)) if thr else (sat > 70)
    m = m.astype(np.uint8) * 255
    m = cv2.morphologyEx(m, cv2.MORPH_OPEN, np.ones((5, 5), np.uint8))
    m = cv2.morphologyEx(m, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (45, 45)))
    # fill holes; ring keeps sheet pockets at the frame edge as background
    mp = cv2.copyMakeBorder(m, 1, 1, 1, 1, cv2.BORDER_CONSTANT, value=0)
    ff = (255 - mp).copy()
    cv2.floodFill(ff, np.zeros((ff.shape[0] + 2, ff.shape[1] + 2), np.uint8), (0, 0), 0)
    return (mp | ff)[1:-1, 1:-1]


def largest(alpha, frac=0.15):
    bin_ = (alpha > 128).astype(np.uint8)
    n, lab, stats, _ = cv2.connectedComponentsWithStats(bin_, 8)
    if n <= 1:
        return alpha
    areas = stats[1:, cv2.CC_STAT_AREA]
    keep = [k + 1 for k, a in enumerate(areas) if a >= frac * areas.max()]
    m = cv2.dilate(np.isin(lab, keep).astype(np.uint8), np.ones((15, 15), np.uint8))
    return (alpha * m).astype(np.uint8)


def get_alpha(rgb, mode):
    """Model mask, plus colour mask for dark/saturated garments. Pieces the model does not back
    (carpet, feet) are dropped; tiny pinholes are filled, real negative space is kept."""
    names = ["isnet-general-use", "birefnet-general-lite"] if mode == "white" else             ["birefnet-general-lite" if mode == "model" else "isnet-general-use"]
    am = None
    for nm in names:
        a = np.array(remove(Image.fromarray(rgb), session=sess(nm), only_mask=True, post_process_mask=True))
        am = a if am is None else np.maximum(am, a)
    cm = colour_mask(rgb, mode)
    union = am if cm is None else np.maximum(am, cm)
    if mode == "white":  # white on white: join the two masks, close gaps, fill enclosed holes
        union = cv2.morphologyEx(union, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (35, 35)))
        mp = cv2.copyMakeBorder(union, 1, 1, 1, 1, cv2.BORDER_CONSTANT, value=0)
        ff = (255 - mp).copy()
        cv2.floodFill(ff, np.zeros((ff.shape[0] + 2, ff.shape[1] + 2), np.uint8), (0, 0), 0)
        union = (mp | ff)[1:-1, 1:-1]
    n, lab, stats, _ = cv2.connectedComponentsWithStats((union > 128).astype(np.uint8), 8)
    keep = np.zeros(union.shape, np.uint8)
    if n > 1:
        big = stats[1:, cv2.CC_STAT_AREA].max()
        model_on = am > 128
        for k in range(1, n):
            area = stats[k, cv2.CC_STAT_AREA]
            if area < 0.15 * big:
                continue
            if model_on[lab == k].mean() >= 0.3:
                keep[lab == k] = 1
    keep = cv2.dilate(keep, np.ones((15, 15), np.uint8))
    alpha = (union * keep).astype(np.uint8)
    # fill tiny enclosed holes only
    inv = (alpha < 128).astype(np.uint8)
    n, lab, stats, _ = cv2.connectedComponentsWithStats(inv, 4)
    lim = 0.0008 * alpha.size
    for k in range(1, n):
        x, y, w, h, a = stats[k]
        if a < lim and x > 0 and y > 0 and x + w < alpha.shape[1] and y + h < alpha.shape[0]:
            alpha[lab == k] = 255
    return alpha


def find_tilt(alpha, maxang=25):
    """Angle (deg, CCW) that makes the garment most left-right symmetric."""
    s = 360 / max(alpha.shape)
    m = cv2.resize(alpha, None, fx=s, fy=s, interpolation=cv2.INTER_AREA) > 128
    h, w = m.shape
    D = int(math.hypot(h, w)) + 6
    cv = np.zeros((D, D), np.float32)
    oy, ox = (D - h) // 2, (D - w) // 2
    cv[oy:oy + h, ox:ox + w] = m
    ys, xs = np.nonzero(cv > 0.5)
    c = (float(xs.mean()), float(ys.mean()))

    def score(a):
        r = cv2.warpAffine(cv, cv2.getRotationMatrix2D(c, a, 1.0), (D, D), flags=cv2.INTER_LINEAR) > 0.5
        x = np.nonzero(r)[1].mean()
        f = cv2.warpAffine(r.astype(np.float32), np.float32([[-1, 0, 2 * x], [0, 1, 0]]), (D, D)) > 0.5
        return (r & f).sum() / max((r | f).sum(), 1)

    angs = np.arange(-maxang, maxang + 0.01, 0.5)
    sc = [score(a) for a in angs]
    best = angs[int(np.argmax(sc))]
    base = score(0.0)
    if abs(best) < 1.0 or max(sc) - base < 0.01:
        return 0.0
    return float(best)


def rotate_rgba(rgba, ang):
    h, w = rgba.shape[:2]
    D = int(math.hypot(h, w)) + 4
    cv = np.zeros((D, D, 4), np.uint8)
    oy, ox = (D - h) // 2, (D - w) // 2
    cv[oy:oy + h, ox:ox + w] = rgba
    M = cv2.getRotationMatrix2D((D / 2, D / 2), ang, 1.0)
    return cv2.warpAffine(cv, M, (D, D), flags=cv2.INTER_CUBIC, borderMode=cv2.BORDER_CONSTANT, borderValue=(0, 0, 0, 0))


def cutout(n, mode, deskew):
    im = load_upright(n)
    # coarse pass for the garment bbox
    small = im.copy(); small.thumbnail((1280, 1280))
    g = wb_gains(np.array(small))
    sm = np.clip(np.array(small) * g, 0, 255).astype(np.uint8)
    a0 = get_alpha(sm, mode)
    ys, xs = np.nonzero(a0 > 128)
    if len(ys) == 0:
        raise RuntimeError(f"no garment found in {n}")
    sx = im.width / small.width
    y0, y1, x0, x1 = ys.min() * sx, (ys.max() + 1) * sx, xs.min() * sx, (xs.max() + 1) * sx
    mx, my = 0.06 * (x1 - x0), 0.06 * (y1 - y0)
    box = (int(max(0, x0 - mx)), int(max(0, y0 - my)), int(min(im.width, x1 + mx)), int(min(im.height, y1 + my)))
    crop = im.crop(box)
    cap = 2000  # garment needs at most ~1600 px; avoid pointless resolution
    if max(crop.size) > cap:
        crop.thumbnail((cap, cap), Image.LANCZOS)
    rgb = np.clip(np.array(crop) * g, 0, 255).astype(np.uint8)
    alpha = get_alpha(rgb, mode)
    alpha = cv2.morphologyEx(alpha, cv2.MORPH_CLOSE, np.ones((7, 7), np.uint8))
    alpha = cv2.GaussianBlur(cv2.erode(alpha, np.ones((3, 3), np.uint8)), (0, 0), 0.9)
    fg = np.clip(estimate_foreground_ml(rgb / 255.0, alpha / 255.0) * 255, 0, 255).astype(np.uint8)
    rgba = np.dstack([fg, alpha])
    ab = alpha > 8
    touches = bool(ab[0].any() or ab[-1].any() or ab[:, 0].any() or ab[:, -1].any())  # garment cut by original frame
    ang = 0.0
    if deskew:
        ang = find_tilt(alpha)
        if ang:
            rgba = rotate_rgba(rgba, ang)
    return rgba, ang, touches


def compose(rgba):
    ys, xs = np.nonzero(rgba[..., 3] > 8)
    y0, y1, x0, x1 = ys.min(), ys.max() + 1, xs.min(), xs.max() + 1
    cropped = Image.fromarray(rgba[y0:y1, x0:x1], "RGBA")
    s = min(W * (1 - 2 * PAD) / cropped.width, H * (1 - 2 * PAD) / cropped.height)
    cropped = cropped.resize((max(1, round(cropped.width * s)), max(1, round(cropped.height * s))), Image.LANCZOS)
    canvas = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    canvas.alpha_composite(cropped, ((W - cropped.width) // 2, (H - cropped.height) // 2))
    return canvas, s


def crop45(im):
    w, h = im.size
    tw = min(w, int(h * 4 / 5)); th = int(tw * 5 / 4)
    im = im.crop(((w - tw) // 2, (h - th) // 2, (w - tw) // 2 + tw, (h - th) // 2 + th))
    return im.resize((W, H), Image.LANCZOS) if im.width >= W else im


if __name__ == "__main__":
    manifest_path = sys.argv[1]
    only = sys.argv[2:]
    M.update(json.load(open(manifest_path, encoding="utf-8")))
    ROT.update({int(k): v for k, v in M["rotations"].items()})
    NO_DESKEW.update(M.get("no_deskew", []))
    OUT = M["out"]
    log_path = os.path.join(os.path.dirname(os.path.abspath(manifest_path)), "report.json")
    report = json.load(open(log_path)) if os.path.exists(log_path) else {}
    for folder, item in M["items"].items():
        if only and not any(o in folder for o in only):
            continue
        base = os.path.join(OUT, folder)
        for sub in ("originals", "edited/transparent"):
            os.makedirs(os.path.join(base, sub), exist_ok=True)
        for slot, n, kind in item["photos"]:
            dst = os.path.join(base, "originals", os.path.basename(src_path(n)))
            if not os.path.exists(dst):
                shutil.copy2(src_path(n), dst)  # originals copied, never modified
            key = f"{folder}/{slot}"
            if kind == "cut":
                rgba, ang, touches = cutout(n, item["mode"], item["deskew"] and n not in NO_DESKEW)
                canvas, s = compose(rgba)
                canvas.save(os.path.join(base, "edited", "transparent", slot + ".png"), optimize=True)
                white = Image.new("RGB", (W, H), (255, 255, 255)); white.paste(canvas, mask=canvas.split()[3])
                white.save(os.path.join(base, "edited", slot + ".png"), optimize=True)
                report[key] = {"src": n, "scale": round(s, 2), "tilt": ang, "touches_frame": touches}
            else:
                crop45(load_upright(n)).save(os.path.join(base, "edited", slot + ".png"), optimize=True)
                report[key] = {"src": n, "closeup": True}
            print(key, report[key], flush=True)
            json.dump(report, open(log_path, "w"), indent=1)
