"""Assemble the reel picture: generated clips, the user's own footage and stills,
with an optional title card, captions and crossfades. Audio is added afterwards
(audio.py builds the mix, mux.swift attaches it).

usage: render.py <spec.json> <out.mp4>
spec: { aspect, title, titleCard, captions,
        segments: [{ kind: clip|footage|still, path, seconds, start, caption, fit: cover|contain }] }
Prints one JSON line: { duration, segments: [{ at, seconds }] }  (timeline for the audio mix)
"""
import sys, os, json, math, cv2, numpy as np
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import text as T

spec = json.load(open(sys.argv[1])); out = sys.argv[2]; os.makedirs(os.path.dirname(out) or ".", exist_ok=True)
W, H = {"9:16": (1080, 1920), "1:1": (1080, 1080), "16:9": (1920, 1080)}.get(spec.get("aspect"), (1080, 1920))
FPS, XF = 30, 9                       # crossfade length in frames
TITLE_FRAMES = int(1.5 * FPS)


def cover(img):
    s = max(W / img.shape[1], H / img.shape[0])
    r = cv2.resize(img, (int(np.ceil(img.shape[1] * s)), int(np.ceil(img.shape[0] * s))), interpolation=cv2.INTER_AREA if s < 1 else cv2.INTER_LINEAR)
    y, x = (r.shape[0] - H) // 2, (r.shape[1] - W) // 2
    return r[y:y + H, x:x + W]


def contain(img):
    """Whole frame preserved, over a blurred fill of itself - for footage that must appear as uploaded."""
    bg = cv2.GaussianBlur(cv2.resize(cover(img), (W // 8, H // 8)), (0, 0), 6)
    bg = (cv2.resize(bg, (W, H), interpolation=cv2.INTER_LINEAR) * 0.55).astype(np.uint8)
    s = min(W / img.shape[1], H / img.shape[0])
    r = cv2.resize(img, (int(img.shape[1] * s), int(img.shape[0] * s)), interpolation=cv2.INTER_AREA if s < 1 else cv2.INTER_LINEAR)
    y, x = (H - r.shape[0]) // 2, (W - r.shape[1]) // 2
    bg[y:y + r.shape[0], x:x + r.shape[1]] = r
    return bg


def fit(img, mode):
    same = abs(img.shape[1] / img.shape[0] - W / H) < 0.02
    return cover(img) if mode != "contain" or same else contain(img)


def caption(frame, text, a):
    """Lower-third caption on a soft pill; a in 0..1 fades it in."""
    if not text or a <= 0: return frame
    size = max(30, W // 26); tw, th = T.measure(text, size, "medium")
    while tw > W * 0.84 and size > 22: size -= 2; tw, th = T.measure(text, size, "medium")
    cx, cy = W // 2, H - int(H * 0.115); px, py = int(size * .7), int(size * .5)
    over = frame.copy()
    cv2.rectangle(over, (cx - tw // 2 - px, cy - th // 2 - py), (cx + tw // 2 + px, cy + th // 2 + py), (12, 12, 14), -1)
    over = T.draw(over, text, (cx, cy), size, (245, 245, 245), "medium", anchor="mm")
    return cv2.addWeighted(over, a * 0.94, frame, 1 - a * 0.94, 0)


def frames_of(seg):
    n = max(1, int(round(seg["seconds"] * FPS))); mode = seg.get("fit", "cover")
    if seg["kind"] == "still":
        img = fit(cv2.imread(seg["path"]), mode)
        for i in range(n):                                     # gentle push so a still is never frozen
            z = 1 + 0.06 * (i / n); M = np.float32([[z, 0, (1 - z) * W / 2], [0, z, (1 - z) * H / 2]])
            yield cv2.warpAffine(img, M, (W, H), flags=cv2.INTER_LINEAR)
        return
    cap = cv2.VideoCapture(seg["path"]); src_fps = cap.get(cv2.CAP_PROP_FPS) or FPS
    total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT)); start = int(float(seg.get("start") or 0) * src_fps)
    if total > 0: start = max(0, min(start, max(0, total - int(seg["seconds"] * src_fps))))
    cap.set(cv2.CAP_PROP_POS_FRAMES, start)
    last, pos = None, 0.0
    for i in range(n):                                         # resample source fps -> 30
        want = int(i * src_fps / FPS)
        while pos <= want:
            ok, f = cap.read(); pos += 1
            if not ok: break
            last = f
        if last is None: last = np.zeros((H, W, 3), np.uint8)
        yield fit(last, mode)
    cap.release()


wr = cv2.VideoWriter(out, cv2.VideoWriter_fourcc(*"avc1"), FPS, (W, H))
assert wr.isOpened(), "could not open video writer"
written = 0
def emit(f):
    global written
    wr.write(f); written += 1

segs = [s for s in spec["segments"] if os.path.exists(s["path"])]
assert segs, "no segments to render"
show_captions = spec.get("captions", True)
timeline, prev_tail = [], []
title = (spec.get("title") or "").strip() if spec.get("titleCard", True) else ""

for si, seg in enumerate(segs):
    fr = list(frames_of(seg)); n = len(fr)
    if show_captions and seg.get("caption"):
        fr = [caption(f, seg["caption"], min(1, max(0, (i - 6) / 10)) * min(1, (n - i) / 8)) for i, f in enumerate(fr)]
    if si == 0 and title:                                      # title over the blurred opening frame
        base = (cv2.GaussianBlur(fr[0], (0, 0), 22) * 0.45).astype(np.uint8)
        size = max(54, W // 13); tw, _ = T.measure(title, size, "bold")
        while tw > W * 0.84 and size > 30: size -= 4; tw, _ = T.measure(title, size, "bold")
        card = T.draw(base, title, (W // 2, H // 2), size, (250, 250, 250), "bold", anchor="mm")
        for i in range(TITLE_FRAMES):
            a = min(1, i / 8); emit(cv2.addWeighted(card, a, np.zeros_like(card), 1 - a, 0))
        prev_tail = [card] * XF
    at = written / FPS
    for i, f in enumerate(fr):
        if i < XF and prev_tail:                               # crossfade from the previous segment
            a = (i + 1) / (XF + 1); f = cv2.addWeighted(f, a, prev_tail[i], 1 - a, 0)
        if si == len(segs) - 1 and n - i <= 14:                # fade out at the very end
            f = (f * ((n - i - 1) / 14)).astype(np.uint8)
        emit(f)
    prev_tail = [fr[-1]] * XF
    timeline.append({"at": round(at, 3), "seconds": round(n / FPS, 3)})
wr.release()
print(json.dumps({"duration": round(written / FPS, 3), "segments": timeline}))
