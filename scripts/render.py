"""Assemble the final reel from a spec: generated clips, stills (Ken Burns) and the
user's own footage, trimmed to the planned seconds, with captions and crossfades.
usage: render.py <spec.json> <out.mp4>"""
import sys, os, json, cv2, numpy as np, math
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__))); import text as T
spec = json.load(open(sys.argv[1])); out = sys.argv[2]; os.makedirs(os.path.dirname(out) or ".", exist_ok=True)
W, H = {"9:16": (1080, 1920), "1:1": (1080, 1080)}.get(spec.get("aspect", "9:16"), (1920, 1080)); FPS = 30
wr = cv2.VideoWriter(out, cv2.VideoWriter_fourcc(*"avc1"), FPS, (W, H))
ease = lambda t: 0.5 - 0.5 * math.cos(math.pi * t)

def fit(img):  # cover-fit to W×H
    h, w = img.shape[:2]; s = max(W / w, H / h); r = cv2.resize(img, (int(w * s), int(h * s)))
    y0, x0 = (r.shape[0] - H) // 2, (r.shape[1] - W) // 2; return r[y0:y0 + H, x0:x0 + W]

def caption(f, text):
    if not text: return f
    f = f.copy(); size = max(28, W // 32); tw, th = T.measure(text, size); x = (W - tw) // 2; y = H - int(H * 0.09)
    cv2.rectangle(f, (x - 28, y - 22), (x + tw + 28, y + th + 22), (10, 10, 12), -1)
    return T.draw(f, text, (W // 2, y + th // 2), size, (240, 240, 240), "medium", anchor="mm")

def frames_of(seg):
    n = int(seg["seconds"] * FPS)
    if seg["kind"] == "still":
        img = cv2.imread(seg["path"]); h, w = img.shape[:2]
        for i in range(n):
            z = 1 + 0.1 * ease(i / max(1, n - 1)); cw, ch = int(w / z), int(h / z); cx, cy = (w - cw) // 2, (h - ch) // 2
            yield fit(img[cy:cy + ch, cx:cx + cw])
        return
    cap = cv2.VideoCapture(seg["path"]); total = int(cap.get(7)); fps = cap.get(5) or FPS
    if total <= 0: return
    # footage: take a centred window of `seconds`; clips: play from the start
    start = max(0, (total - int(seg["seconds"] * fps)) // 2) if seg["kind"] == "footage" else 0
    cap.set(1, start); last = None
    for i in range(n):
        ok, f = cap.read()
        if not ok:
            if last is None: return
            yield last; continue
        last = fit(f); yield last

title = spec.get("title", "")
if title:  # 1.2 s title card
    card = np.full((H, W, 3), (12, 12, 16), np.uint8)
    card = T.draw(card, title, (W // 2, H // 2), max(40, W // 18), (240, 240, 240), "light", anchor="mm")
    for i in range(int(1.2 * FPS)): wr.write(card)
    prev = card
else: prev = None
XF = int(0.4 * FPS)
for seg in spec["segments"]:
    buf = []
    for i, f in enumerate(frames_of(seg)):
        f = caption(f, seg.get("caption"))
        if i < XF and prev is not None: f = cv2.addWeighted(prev, 1 - ease(i / XF), f, ease(i / XF), 0)
        wr.write(f); buf = f
    if isinstance(buf, np.ndarray): prev = buf
# fade out
if prev is not None:
    black = np.zeros_like(prev)
    for i in range(int(0.8 * FPS)): wr.write(cv2.addWeighted(prev, 1 - ease(i / (0.8 * FPS)), black, ease(i / (0.8 * FPS)), 0))
wr.release(); print(out)
