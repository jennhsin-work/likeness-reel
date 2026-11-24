"""Extract N evenly spaced frames from a clip (or copy a photo) for analysis.
usage: frames.py <input> <outdir> <prefix> <n>   → prints one path per line, then #duration=<s>"""
import sys, os, cv2
src, outdir, prefix, n = sys.argv[1], sys.argv[2], sys.argv[3], int(sys.argv[4])
os.makedirs(outdir, exist_ok=True)
ext = os.path.splitext(src)[1].lower()
paths, duration = [], 0.0
if ext in (".jpg", ".jpeg", ".png", ".webp"):
    img = cv2.imread(src)
    if img is None: sys.exit("could not read image")
    h, w = img.shape[:2]; s = min(1.0, 1280 / max(w, h)); img = cv2.resize(img, (int(w * s), int(h * s)))
    p = os.path.join(outdir, f"{prefix}_0.jpg"); cv2.imwrite(p, img, [cv2.IMWRITE_JPEG_QUALITY, 85]); paths.append(p)
else:
    cap = cv2.VideoCapture(src)
    total, fps = int(cap.get(cv2.CAP_PROP_FRAME_COUNT)), cap.get(cv2.CAP_PROP_FPS) or 30
    if total <= 0: sys.exit("could not read video")
    duration = total / fps
    for i in range(n):
        cap.set(cv2.CAP_PROP_POS_FRAMES, int((i + 0.5) * total / n)); ok, f = cap.read()
        if not ok: continue
        h, w = f.shape[:2]; s = min(1.0, 1280 / max(w, h)); f = cv2.resize(f, (int(w * s), int(h * s)))
        p = os.path.join(outdir, f"{prefix}_{i}.jpg"); cv2.imwrite(p, f, [cv2.IMWRITE_JPEG_QUALITY, 85]); paths.append(p)
print("\n".join(paths)); print(f"#duration={duration:.2f}")
