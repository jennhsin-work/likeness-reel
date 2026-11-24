"""Synthetic sample assets for exercising the pipeline without personal media:
an illustrated face (3 angles), a full-body figure, a 'café' clip and a street photo.
usage: samples.py <outdir>"""
import sys, os, cv2, numpy as np, math
out = sys.argv[1]; os.makedirs(out, exist_ok=True)

def face(angle, name):
    img = np.full((900, 700, 3), (210, 190, 170), np.uint8)
    cx = 350 + angle * 40
    cv2.ellipse(img, (cx, 440), (190, 250), 0, 0, 360, (150, 170, 220), -1)          # head
    cv2.ellipse(img, (cx, 300), (210, 130), 0, 180, 360, (40, 30, 25), -1)           # hair
    for dx in (-70, 70): cv2.ellipse(img, (cx + dx + angle * 15, 420), (28, 16), 0, 0, 360, (255, 255, 255), -1); cv2.circle(img, (cx + dx + angle * 22, 420), 11, (30, 40, 60), -1)
    cv2.ellipse(img, (cx + angle * 10, 500), (14, 30), 0, 0, 360, (120, 140, 200), -1)  # nose
    cv2.ellipse(img, (cx, 580), (60, 22), 0, 0, 180, (90, 70, 140), 4)              # smile
    cv2.putText(img, name, (40, 860), cv2.FONT_HERSHEY_SIMPLEX, 1, (80, 80, 80), 2)
    return img
for i, (a, n) in enumerate([(0, "front"), (-1, "left 3/4"), (1, "right 3/4")]): cv2.imwrite(f"{out}/face_{i}.jpg", face(a, n))

body = np.full((1600, 800, 3), (225, 225, 230), np.uint8)
cv2.ellipse(body, (400, 220), (90, 115), 0, 0, 360, (150, 170, 220), -1); cv2.ellipse(body, (400, 150), (100, 70), 0, 180, 360, (40, 30, 25), -1)
cv2.rectangle(body, (300, 330), (500, 760), (70, 90, 160), -1); cv2.rectangle(body, (310, 760), (390, 1300), (50, 50, 70), -1); cv2.rectangle(body, (410, 760), (490, 1300), (50, 50, 70), -1)
cv2.rectangle(body, (230, 340), (300, 720), (150, 170, 220), -1); cv2.rectangle(body, (500, 340), (570, 720), (150, 170, 220), -1)
cv2.imwrite(f"{out}/body_0.jpg", body)

W, H, FPS = 1280, 720, 30
wr = cv2.VideoWriter(f"{out}/cafe.mp4", cv2.VideoWriter_fourcc(*"avc1"), FPS, (W, H))
for i in range(FPS * 6):
    t = i / (FPS * 6); f = np.zeros((H, W, 3), np.uint8)
    f[:] = (60, 80, 120); f[400:] = (90, 110, 140)
    cv2.rectangle(f, (0, 0), (W, 400), (170, 200, 235), -1)                                # sky
    for k in range(6): x = int((k * 260 - t * 300) % (W + 260)) - 130; cv2.rectangle(f, (x, 120), (x + 200, 400), (120 + k * 10, 110, 100), -1); cv2.rectangle(f, (x + 40, 200), (x + 90, 260), (230, 240, 255), -1)
    cv2.ellipse(f, (640, 520), (260, 60), 0, 0, 360, (210, 200, 190), -1)                   # table
    cv2.circle(f, (560, 500), 48, (250, 250, 250), -1); cv2.circle(f, (560, 500), 36, (70, 40, 20), -1)  # coffee
    cv2.ellipse(f, (740, 505), (70, 32), 0, 0, 360, (90, 150, 220), -1)                     # pastry
    cv2.putText(f, "CAFE DE FLORE", (420, 80), cv2.FONT_HERSHEY_DUPLEX, 1.4, (255, 255, 255), 2)
    wr.write(f)
wr.release()
street = np.zeros((900, 1600, 3), np.uint8); street[:] = (90, 100, 110); street[500:] = (70, 70, 75)
for k in range(7): cv2.rectangle(street, (k * 240, 150 - k * 10), (k * 240 + 200, 500), (120 + k * 8, 115, 110), -1)
cv2.putText(street, "rue de Rivoli", (60, 860), cv2.FONT_HERSHEY_SIMPLEX, 1.2, (230, 230, 230), 2)
cv2.imwrite(f"{out}/street.jpg", street); print("ok")
