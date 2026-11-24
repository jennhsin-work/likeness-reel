"""Preview-mode still: the user's real face (detected + cropped) composited onto a
reference environment frame (or a gradient), with a shot caption and a PREVIEW tag.
This is deliberately NOT a generated likeness — it lets the whole pipeline (shot
list → approval → animation → render) be exercised before paying for generation.
usage: compose_still.py <face> <body|-> <env|-> <aspect> <caption> <out>"""
import sys, os, cv2, numpy as np
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__))); import text as T
face_p, body_p, env_p, aspect, caption, out = sys.argv[1:7]
W, H = {"9:16": (1080, 1920), "1:1": (1080, 1080)}.get(aspect, (1920, 1080))

def face_crop(path):
    img = cv2.imread(path)
    if img is None: return None
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    casc = cv2.CascadeClassifier(cv2.data.haarcascades + "haarcascade_frontalface_default.xml")
    faces = casc.detectMultiScale(gray, 1.2, 5, minSize=(60, 60))
    if len(faces):
        x, y, w, h = max(faces, key=lambda f: f[2] * f[3]); pad = int(w * 0.45)
        x0, y0, x1, y1 = max(0, x - pad), max(0, y - int(pad * 1.2)), min(img.shape[1], x + w + pad), min(img.shape[0], y + h + pad)
        return img[y0:y1, x0:x1]
    h, w = img.shape[:2]; s = min(h, w); return img[(h - s) // 2:(h + s) // 2, (w - s) // 2:(w + s) // 2]

bg = cv2.imread(env_p) if env_p != "-" else None
if bg is None:
    bg = np.zeros((H, W, 3), np.uint8)
    for y in range(H): bg[y, :] = (40 + 30 * y / H, 28 + 20 * y / H, 36 + 50 * y / H)
else:
    h, w = bg.shape[:2]; s = max(W / w, H / h); bg = cv2.resize(bg, (int(w * s), int(h * s)))
    y0, x0 = (bg.shape[0] - H) // 2, (bg.shape[1] - W) // 2; bg = bg[y0:y0 + H, x0:x0 + W]
    bg = cv2.GaussianBlur(bg, (0, 0), 6)
frame = bg.copy()
subj = cv2.imread(body_p) if body_p != "-" else None
if subj is None: subj = face_crop(face_p)
if subj is not None:
    sh, sw = subj.shape[:2]; target_h = int(H * (0.62 if body_p != "-" else 0.42)); s = target_h / sh
    subj = cv2.resize(subj, (int(sw * s), target_h)); sh, sw = subj.shape[:2]
    x, y = (W - sw) // 2, int(H * 0.58) - sh // 2
    mask = np.zeros((sh, sw), np.uint8); cv2.ellipse(mask, (sw // 2, sh // 2), (sw // 2 - 2, sh // 2 - 2), 0, 0, 360, 255, -1); mask = cv2.GaussianBlur(mask, (0, 0), 12)
    roi = frame[y:y + sh, x:x + sw]; m = (mask / 255.0)[..., None]
    frame[y:y + sh, x:x + sw] = (roi * (1 - m) + subj * m).astype(np.uint8)
# caption + preview tag
cv2.rectangle(frame, (0, H - 150), (W, H), (14, 14, 18), -1)
frame = T.draw(frame, caption[:60], (48, H - 112), max(28, W // 30), (240, 240, 240), "medium")
frame = T.draw(frame, "PREVIEW · no generator key set; real likeness generation runs with FAL_KEY", (48, H - 56), max(18, W // 60), (160, 160, 170), "light")
os.makedirs(os.path.dirname(out) or ".", exist_ok=True)
assert cv2.imwrite(out, frame, [cv2.IMWRITE_JPEG_QUALITY, 90]), f"could not write {out}"; print(out)
