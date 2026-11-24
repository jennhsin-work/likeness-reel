"""Unicode-safe text drawing for OpenCV frames (cv2.putText has no accents).
draw(frame_bgr, text, (x, y), size, color_bgr, weight) -> new frame; measure(text, size, weight) -> (w, h)."""
import cv2, numpy as np
from PIL import Image, ImageDraw, ImageFont
_FONTS = {}
def font(size, weight="medium"):
    key = (size, weight)
    if key not in _FONTS:
        idx = {"light": 7, "medium": 10, "bold": 1}.get(weight, 10)
        try: _FONTS[key] = ImageFont.truetype("/System/Library/Fonts/HelveticaNeue.ttc", size, index=idx)
        except Exception: _FONTS[key] = ImageFont.load_default()
    return _FONTS[key]
def measure(text, size, weight="medium"):
    l, t, r, b = font(size, weight).getbbox(text); return r - l, b - t
def draw(frame, text, xy, size, color=(240, 240, 240), weight="medium", anchor="la"):
    im = Image.fromarray(cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)); d = ImageDraw.Draw(im)
    d.text(xy, text, font=font(size, weight), fill=(color[2], color[1], color[0]), anchor=anchor)
    return cv2.cvtColor(np.asarray(im), cv2.COLOR_RGB2BGR)
