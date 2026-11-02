"""Builds the sign-in scene's derived layers from the approved art. The originals are read only.

  public/login/road-{day,night}.webp   the highway paintings, light enough to load at sign-in
  public/login/toll-{day,night}.webp   the toll plaza paintings, likewise
  public/login/toll-top-{day,night}.webp  the same, with the road cut away: the 3D carries the road off with the canopy
  public/login/patch-{day,night}.webp  see-through patch: the road with its painted lane dashes removed (the 3D redraws them)
  public/login/rail-{l,r}-{day,night}.webp  the painted guardrail and verge, flattened to a strip that tiles

The painted dashes and guardrail posts bow and are unevenly spaced, so nothing here assumes straight perspective:
the moving copies follow the measured paths below, which pass through every painted dash and post. A moving frame at
rest is therefore the painting.

Run from Front-End-Dashboard (needs opencv-python-headless, numpy): python scripts/build-login-layers.py
DASH_* and RAIL below must match the same names in components/login/login-scene.ts. All coordinates are art px
(1672 x 941); the highway paintings are exactly twice that.
"""
import numpy as np, cv2
OUT = "public/login"
ROAD = {"day": "public/light_login_clear.png", "night": "public/dark_login_clear.png"}
TOLL = {"day": "public/light_login_toll.png", "night": "public/dark_login_toll.png"}
SCALE = 2
W, H = 1672 * SCALE, 941 * SCALE

# The two dash lines: half their separation either side of DASH_CX, at each painted dash's height.
DASH_CX = 642
DASH_Y = [1318, 1034, 856.5, 734.2, 654.7, 620.2, 602.5, 590, 582]
DASH_HALF = [866, 562, 374, 247, 153.5, 106.6, 80.6, 62, 50]

# Each guardrail side: the band's own vanishing point, its slopes, and the x of each post's reflector, nearest first.
RAIL = {
    "l": {"vp": (589, 563), "top": 0.0584, "bot": 0.1544, "posts": [115, 237, 314, 359, 407, 443], "sign": -1},
    "r": {"vp": (723, 564), "top": 0.0440, "bot": 0.1226, "posts": [1598, 1416, 1278, 1170, 1081, 1023], "sign": 1},
}
RAIL_POSTS = 3           # one tile holds this many post spacings


def post_curve(xs, vpx):
    """1 / distance from the vanishing point, as a quadratic in post number: a smooth path through the posts."""
    inv = 1 / np.abs(np.array(xs) - vpx)
    return np.polyfit(np.arange(len(xs)), inv, 2)


def dash_mask(img):
    """White paint in the corridor of the two dash lines."""
    g = cv2.GaussianBlur(img, (0, 0), 1.2).min(axis=2).astype(np.float32)
    local = cv2.GaussianBlur(g, (0, 0), 24)
    ys = np.arange(H)[:, None] / SCALE
    xs = np.arange(W)[None, :] / SCALE
    half = np.interp(ys, DASH_Y[::-1], DASH_HALF[::-1])
    near = np.abs(np.abs(xs - DASH_CX) - half) < np.maximum(half * 0.16, 7)
    m = ((g - local > np.where(ys < 640, 6, 14)) & near & (ys > 596)).astype(np.uint8) * 255
    return cv2.dilate(m, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (9, 9)))


def patch(name, img, mask):
    # A thin mask over smooth road: a wide radius would pull the sheen in, so fill small and put the grain back.
    small = cv2.resize(img, None, fx=0.5, fy=0.5, interpolation=cv2.INTER_AREA)
    sm = cv2.dilate(cv2.resize(mask, None, fx=0.5, fy=0.5, interpolation=cv2.INTER_AREA), np.ones((3, 3), np.uint8))
    filled = cv2.resize(cv2.inpaint(small, sm, 7, cv2.INPAINT_TELEA), (W, H), interpolation=cv2.INTER_CUBIC).astype(np.float32)
    grain = img.astype(np.float32) - cv2.GaussianBlur(img, (0, 0), 4).astype(np.float32)
    grain = np.roll(grain, 340, axis=1)
    filled = np.clip(cv2.GaussianBlur(filled, (0, 0), 2.5) + grain, 0, 255)
    a = cv2.GaussianBlur(mask, (0, 0), 2.5)
    cv2.imwrite(f"{OUT}/patch-{name}.webp", np.dstack([filled.astype(np.uint8), a]), [cv2.IMWRITE_WEBP_QUALITY, 88])


def rail(name, img, side, coef):
    S = RAIL[side]
    TW, TH = 2048, 200
    vx, vy = S["vp"]
    ps = -0.5 + (np.arange(TW) + 0.5) / TW * (RAIL_POSTS + 0.25)   # a little over, to dissolve the seam
    d = 1 / np.polyval(coef, ps)
    vs = (np.arange(TH) + 0.5) / TH
    top = vy + d * S["top"]
    bot = vy + d * S["bot"]
    mx = np.tile(vx + S["sign"] * d, (TH, 1)).astype(np.float32) * SCALE
    my = (top[None, :] + (bot - top)[None, :] * vs[:, None]).astype(np.float32) * SCALE
    strip = cv2.remap(img, mx, my, cv2.INTER_CUBIC, borderMode=cv2.BORDER_REPLICATE)
    n = round(TW * 0.25 / (RAIL_POSTS + 0.25))
    t = (np.arange(n) / (n - 1))[None, :, None]
    body = strip[:, :TW - n].astype(np.float32)
    body[:, :n] = strip[:, TW - n:].astype(np.float32) * (1 - t) + strip[:, :n].astype(np.float32) * t
    cv2.imwrite(f"{OUT}/rail-{side}-{name}.webp", np.clip(body, 0, 255).astype(np.uint8), [cv2.IMWRITE_WEBP_QUALITY, 88])


road = {k: cv2.imread(v) for k, v in ROAD.items()}
assert all(i.shape[:2] == (H, W) for i in road.values())
# The painted road's edge, above which the toll painting stays put. Must match TOLL_EDGE in login-scene.ts.
E = {"lx": 625, "ls": 0.105, "ry": 562, "rs": 0.0665, "rx": 680, "feather": 10}
yy, xx = np.mgrid[0:941, 0:1672].astype(np.float32)
edge = np.maximum(E["lx"] - E["ls"] * xx, E["ry"] + E["rs"] * (xx - E["rx"]))
t = np.clip((yy - edge) / E["feather"], 0, 1)
above = ((1 - t * t * (3 - 2 * t)) * 255).astype(np.uint8)
for k, v in TOLL.items():
    img = cv2.resize(cv2.imread(v), (1672, 941), interpolation=cv2.INTER_CUBIC)
    cv2.imwrite(f"{OUT}/toll-{k}.webp", img, [cv2.IMWRITE_WEBP_QUALITY, 90])
    cv2.imwrite(f"{OUT}/toll-top-{k}.webp", np.dstack([img, above]), [cv2.IMWRITE_WEBP_QUALITY, 90])
for k, img in road.items():
    cv2.imwrite(f"{OUT}/road-{k}.webp", img, [cv2.IMWRITE_WEBP_QUALITY, 88])

shared = dash_mask(road["day"])
for k, img in road.items():
    patch(k, img, shared)

curves = {}
for side, S in RAIL.items():
    curves[side] = post_curve(S["posts"], S["vp"][0])
    print(side, "curve", [round(float(c), 8) for c in curves[side]])
for k, img in road.items():
    for side in RAIL:
        rail(k, img, side, curves[side])
