"""Preview-mode animation: a slow push/pan over a still (stand-in for image-to-video).
usage: kenburns.py <still> <seconds> <motion prompt> <out.mp4>"""
import sys, os, cv2, numpy as np, math
src, seconds, motion, out = sys.argv[1], float(sys.argv[2]), sys.argv[3].lower(), sys.argv[4]
img = cv2.imread(src); assert img is not None, f"cannot read {src}"; os.makedirs(os.path.dirname(out) or ".", exist_ok=True); H, W = img.shape[:2]; FPS = 30; n = int(seconds * FPS)
pan = -1 if "left" in motion else 1 if "right" in motion else 0
zoom_in = "pull" not in motion and "out" not in motion
wr = cv2.VideoWriter(out, cv2.VideoWriter_fourcc(*"avc1"), FPS, (W, H))
for i in range(n):
    t = 0.5 - 0.5 * math.cos(math.pi * i / max(1, n - 1))
    z = (1.0 + 0.12 * t) if zoom_in else (1.12 - 0.12 * t)
    cw, ch = int(W / z), int(H / z); cx = int((W - cw) / 2 + pan * t * (W - cw) / 2); cy = int((H - ch) / 2 * (0.6 + 0.4 * t))
    wr.write(cv2.resize(img[cy:cy + ch, cx:cx + cw], (W, H), interpolation=cv2.INTER_CUBIC))
wr.release(); print(out)
