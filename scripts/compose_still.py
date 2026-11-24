"""Preview-mode still compositor (stand-in for an identity-preserving image model).

Cuts the person out of their own reference photo and places them into an
environment plate, framed according to the shot. It is NOT a generated likeness:
it exists so the whole pipeline (plan -> still -> approve -> animate -> render)
can be exercised, and its stills approved, before any money is spent.

usage: compose_still.py <spec.json>
spec: { face, body|null, env|null, aspect, framing, out, seed }
Writes <out> plus <out>.plate.jpg and <out>.subject.png (layers used for parallax).
"""
import sys, os, json, cv2, numpy as np
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import text as T

spec = json.load(open(sys.argv[1]))
out = spec["out"]; os.makedirs(os.path.dirname(out) or ".", exist_ok=True)
W, H = {"9:16": (1080, 1920), "1:1": (1080, 1080), "16:9": (1920, 1080)}.get(spec.get("aspect"), (1080, 1920))
rng = np.random.default_rng(int(spec.get("seed", 0)) % (2 ** 32))
framing = (spec.get("framing") or "").lower()


def cover(img, w, h):
    s = max(w / img.shape[1], h / img.shape[0])
    r = cv2.resize(img, (int(np.ceil(img.shape[1] * s)), int(np.ceil(img.shape[0] * s))), interpolation=cv2.INTER_AREA if s < 1 else cv2.INTER_CUBIC)
    y, x = (r.shape[0] - h) // 2, (r.shape[1] - w) // 2
    return r[y:y + h, x:x + w]


def cutout(img):
    """Foreground mask for a portrait/full-body photo. Plain backdrops are keyed by
    colour; everything else goes through GrabCut seeded from the frame border."""
    s = 720 / max(img.shape[:2]); small = cv2.resize(img, (int(img.shape[1] * s), int(img.shape[0] * s)))
    h, w = small.shape[:2]; lab = cv2.cvtColor(small, cv2.COLOR_BGR2LAB).astype(np.float32)
    b = max(4, int(min(h, w) * 0.03))
    border = np.concatenate([lab[:b].reshape(-1, 3), lab[:, :b].reshape(-1, 3), lab[:, -b:].reshape(-1, 3)])
    dist = np.linalg.norm(lab - np.median(border, axis=0), axis=2)
    # a studio floor is lit differently from the wall, so key the bottom corners as well
    c = max(8, int(min(h, w) * 0.12)); floor = np.concatenate([lab[-c:, :c].reshape(-1, 3), lab[-c:, -c:].reshape(-1, 3)])
    if float(np.std(floor, axis=0).mean()) < 12.0:
        fdist = np.linalg.norm(lab - np.median(floor, axis=0), axis=2); fdist[: int(h * 0.55)] = 1e3   # only near the ground
        dist = np.minimum(dist, fdist)
    plain = float(np.std(border, axis=0).mean()) < 9.0
    if plain:
        mask = (dist > 16).astype(np.uint8)
    else:
        gc = np.full((h, w), cv2.GC_PR_FGD, np.uint8)
        gc[dist < 12] = cv2.GC_PR_BGD
        gc[:b], gc[:, :b], gc[:, -b:] = cv2.GC_BGD, cv2.GC_BGD, cv2.GC_BGD
        gc[-c:, :c], gc[-c:, -c:] = cv2.GC_BGD, cv2.GC_BGD
        gc[int(h * .3):int(h * .9), int(w * .4):int(w * .6)] = cv2.GC_FGD
        try:
            cv2.grabCut(small, gc, None, np.zeros((1, 65)), np.zeros((1, 65)), 4, cv2.GC_INIT_WITH_MASK)
            mask = ((gc == cv2.GC_FGD) | (gc == cv2.GC_PR_FGD)).astype(np.uint8)
        except cv2.error:
            mask = np.zeros((h, w), np.uint8)
    k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5))
    mask = cv2.morphologyEx(cv2.morphologyEx(mask, cv2.MORPH_OPEN, k), cv2.MORPH_CLOSE, np.ones((3, 3), np.uint8))
    n, labels, stats, _ = cv2.connectedComponentsWithStats(mask)
    if n > 1: mask = (labels == 1 + int(np.argmax(stats[1:, cv2.CC_STAT_AREA]))).astype(np.uint8)
    frac = mask.mean()
    if frac < 0.06 or frac > 0.9:   # segmentation failed: fall back to a soft portrait oval
        mask = np.zeros((h, w), np.uint8); cv2.ellipse(mask, (w // 2, h // 2), (int(w * .36), int(h * .46)), 0, 0, 360, 1, -1)
    mask = cv2.erode(mask, np.ones((3, 3), np.uint8))               # pull the edge in a touch so no backdrop halo survives
    mask = cv2.GaussianBlur(mask.astype(np.float32), (0, 0), 1.6)
    mask = cv2.resize(mask, (img.shape[1], img.shape[0]))
    ys, xs = np.where(mask > 0.5)
    y0, y1, x0, x1 = ys.min(), ys.max() + 1, xs.min(), xs.max() + 1
    return img[y0:y1, x0:x1], mask[y0:y1, x0:x1]


def face_region(img):
    """Head-and-shoulders crop around the largest detected face (or the upper centre)."""
    cas = cv2.CascadeClassifier(cv2.data.haarcascades + "haarcascade_frontalface_default.xml")
    faces = cas.detectMultiScale(cv2.cvtColor(img, cv2.COLOR_BGR2GRAY), 1.1, 5, minSize=(60, 60))
    h, w = img.shape[:2]
    if len(faces):
        x, y, fw, fh = max(faces, key=lambda f: f[2] * f[3])
        x0, x1 = max(0, int(x - fw * .9)), min(w, int(x + fw * 1.9)); y0, y1 = max(0, int(y - fh * .7)), min(h, int(y + fh * 2.4))
        return img[y0:y1, x0:x1]
    return img


# ---- environment plate -----------------------------------------------------------
face = cv2.imread(spec["face"]); assert face is not None, f"cannot read face photo {spec['face']}"
body = cv2.imread(spec["body"]) if spec.get("body") else None
env = cv2.imread(spec["env"]) if spec.get("env") else None
if env is not None:
    plate = cv2.GaussianBlur(cover(env, W, H), (0, 0), 5)
else:  # no reference footage: a soft two-tone backdrop taken from the photo's own colours
    src = body if body is not None else face
    c1 = src[: src.shape[0] // 4].reshape(-1, 3).mean(0); c2 = src[-src.shape[0] // 4:].reshape(-1, 3).mean(0)
    t = np.linspace(0, 1, H, dtype=np.float32)[:, None, None]
    plate = np.broadcast_to((c1 * .55 + 40) * (1 - t) + (c2 * .35 + 20) * t, (H, W, 3)).astype(np.uint8).copy()

# ---- subject ---------------------------------------------------------------------
close = any(k in framing for k in ("close", "portrait", "head", "selfie", "bust"))
wide = any(k in framing for k in ("wide", "full", "establish", "long shot"))
use_body = body is not None and not close
subj, mask = cutout(body if use_body else face_region(face) if not close else face)
target_h = H * (0.62 if wide else 0.78 if use_body else 0.92 if close else 0.7)
s = min(target_h / subj.shape[0], W * 0.86 / subj.shape[1])
subj = cv2.resize(subj, None, fx=s, fy=s, interpolation=cv2.INTER_AREA if s < 1 else cv2.INTER_CUBIC); mask = cv2.resize(mask, (subj.shape[1], subj.shape[0]))
sh, sw = subj.shape[:2]
side = -1 if "left" in framing else 1 if "right" in framing else int(rng.integers(-1, 2))
x = int(np.clip((W - sw) / 2 + side * W * 0.12, 0, W - sw)); y = H - sh - (int(H * 0.035) if use_body else 0)

# pull the subject's colour a little toward the plate so it sits in the scene
roi_lab = cv2.cvtColor(plate[y:y + sh, x:x + sw], cv2.COLOR_BGR2LAB).astype(np.float32)
s_lab = cv2.cvtColor(subj, cv2.COLOR_BGR2LAB).astype(np.float32)
m = mask > 0.5
if m.any():
    shift = (roi_lab.reshape(-1, 3).mean(0) - s_lab[m].mean(0)) * np.array([0.10, 0.22, 0.22], np.float32)
    subj = cv2.cvtColor(np.clip(s_lab + shift, 0, 255).astype(np.uint8), cv2.COLOR_LAB2BGR)

layer = np.zeros((H, W, 4), np.uint8); layer[y:y + sh, x:x + sw, :3] = subj; layer[y:y + sh, x:x + sw, 3] = (mask * 255).astype(np.uint8)
if use_body:  # contact shadow under the feet
    sm = np.zeros((H, W), np.float32); cv2.ellipse(sm, (x + sw // 2, y + sh - 6), (int(sw * .42), max(10, int(sh * .022))), 0, 0, 360, 1, -1)
    plate = (plate * (1 - 0.45 * cv2.GaussianBlur(sm, (0, 0), 14)[..., None])).astype(np.uint8)

# ---- grade: vignette + grain so the two layers read as one frame ------------------------
yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
vig = 1 - 0.32 * np.clip(((xx - W / 2) / (W * .75)) ** 2 + ((yy - H / 2) / (H * .75)) ** 2, 0, 1)
plate = (plate * vig[..., None]).astype(np.uint8)
a = layer[..., 3:4].astype(np.float32) / 255
frame = (plate * (1 - a) + layer[..., :3] * a).astype(np.float32)
frame = np.clip(frame + rng.normal(0, 2.2, (H, W, 1)), 0, 255).astype(np.uint8)

# small badge: this is a composite, not a generation
bw, bh = T.measure("PREVIEW COMPOSITE", 24, "bold")
cv2.rectangle(frame, (36, 36), (36 + bw + 36, 36 + bh + 30), (20, 20, 24), -1)
frame = T.draw(frame, "PREVIEW COMPOSITE", (54, 48), 24, (235, 235, 240), "bold")

assert cv2.imwrite(out, frame, [cv2.IMWRITE_JPEG_QUALITY, 92]), f"could not write {out}"
cv2.imwrite(out + ".plate.jpg", plate, [cv2.IMWRITE_JPEG_QUALITY, 90]); cv2.imwrite(out + ".subject.png", layer)
print(out)
