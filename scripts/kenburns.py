"""Preview-mode animation (stand-in for an image-to-video model).

If the still came from the preview compositor its two layers are animated
separately - the plate drifts and zooms while the subject moves a little less -
which reads as camera parallax. Otherwise it is a plain eased push/pan.

usage: kenburns.py <still> <seconds> <motion prompt> <out.mp4>
"""
import sys, os, math, cv2, numpy as np
src, seconds, motion, out = sys.argv[1], float(sys.argv[2]), sys.argv[3].lower(), sys.argv[4]
img = cv2.imread(src); assert img is not None, f"cannot read {src}"
os.makedirs(os.path.dirname(out) or ".", exist_ok=True)
H, W = img.shape[:2]; FPS = 30; n = max(2, int(round(seconds * FPS)))
pan = -1 if ("left" in motion and "right" not in motion) else 1 if "right" in motion else 0
tilt = -1 if "tilt up" in motion or "crane up" in motion else 1 if "tilt down" in motion else 0
zoom_out = any(k in motion for k in ("pull back", "pull out", "zoom out", "pulls back", "dolly out"))
static = "static" in motion or "locked" in motion
amount = 0.04 if static else 0.11


def view(layer, z, dx, dy, interp=cv2.INTER_LINEAR):
    """Scale about the centre by z and shift by (dx, dy) pixels."""
    M = np.float32([[z, 0, (1 - z) * W / 2 + dx], [0, z, (1 - z) * H / 2 + dy]])
    return cv2.warpAffine(layer, M, (W, H), flags=interp, borderMode=cv2.BORDER_REFLECT)


plate_p, subj_p = src + ".plate.jpg", src + ".subject.png"
layers = os.path.exists(plate_p) and os.path.exists(subj_p)
if layers:
    plate = cv2.imread(plate_p); subj = cv2.imread(subj_p, cv2.IMREAD_UNCHANGED)
    alpha = subj[..., 3:4].astype(np.float32) / 255; subj_rgb = subj[..., :3].astype(np.float32)

wr = cv2.VideoWriter(out, cv2.VideoWriter_fourcc(*"avc1"), FPS, (W, H))
assert wr.isOpened(), "could not open video writer"
for i in range(n):
    t = 0.5 - 0.5 * math.cos(math.pi * i / (n - 1))          # ease in-out
    k = (1 - t) if zoom_out else t
    z = 1.02 + amount * k
    dx, dy = -pan * W * 0.035 * (t - 0.5) * 2, -tilt * H * 0.03 * (t - 0.5) * 2
    if layers:
        bg = view(plate, z + 0.03, dx * 1.6, dy * 1.6).astype(np.float32)
        M = np.float32([[z, 0, (1 - z) * W / 2 + dx * 0.5], [0, z, (1 - z) * H + dy * 0.5]])   # subject scales from the feet
        fg = cv2.warpAffine(subj_rgb, M, (W, H), flags=cv2.INTER_LINEAR); fa = cv2.warpAffine(alpha, M, (W, H), flags=cv2.INTER_LINEAR)[..., None]
        bob = math.sin(i / FPS * 2 * math.pi * 0.45) * H * 0.0015                                   # faint breathing so it is not a frozen cut-out
        if abs(bob) > 0.2:
            B = np.float32([[1, 0, 0], [0, 1, bob]]); fg = cv2.warpAffine(fg, B, (W, H)); fa = cv2.warpAffine(fa, B, (W, H))[..., None]
        frame = (bg * (1 - fa) + fg * fa).astype(np.uint8)
    else:
        frame = view(img, z, dx, dy, cv2.INTER_CUBIC)
    wr.write(frame)
wr.release(); print(out)
