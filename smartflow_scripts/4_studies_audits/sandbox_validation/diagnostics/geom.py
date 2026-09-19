PAD, GUT, AXIS = 8, 46, 22
LW, EXAG, LMIN = 3.5, 4, 26
def canvasH(W, lanes, seg, ex, maxL):
    g = GUT if ex else 0
    laneH = max(LMIN, min(maxL, LW*(W/seg)*EXAG))
    return round(PAD*2 + g + AXIS + laneH*lanes)
def layout(W, H, lanes, seg, ex, maxL, above):
    g = GUT if ex else 0
    laneH = max(6, min((H-PAD*2-g-AXIS)/lanes, maxL, max(LMIN, LW*(W/seg)*EXAG)))
    roadH = laneH*lanes
    sa = PAD + (g if above else AXIS); sb = PAD + (AXIS if above else g)
    top = sa + max(0, (H - sa - sb - roadH)/2)
    return laneH, roadH, top
print(f"{'dir':>3} {'seg':>7} {'H':>5} {'laneH':>6} {'road':>13} {'axis':>6} {'ramps':>12} {'ok'}")
for above, d in ((True,"NB"), (False,"SB")):
    for seg in (300, 600, 2000, 8440):
        W, lanes, maxL = 1900, 4, 240
        H = canvasH(W, lanes, seg, 1, maxL)
        laneH, roadH, top = layout(W, H, lanes, seg, 1, maxL, above)
        bot = top + roadH
        axis = (bot + 5, bot + 15) if above else (top - 15, top - 5)   # text extent
        ramp = (top - GUT, top) if above else (bot, bot + GUT)
        ok = (axis[0] >= 0 and axis[1] <= H and ramp[0] >= 0 and ramp[1] <= H
              and not (axis[0] < ramp[1] and ramp[0] < axis[1]))
        print(f"{d:>3} {seg:>6}m {H:>5} {laneH:>6.1f} {top:>6.0f}-{bot:<6.0f} "
              f"{axis[0]:>5.0f}  {ramp[0]:>5.0f}-{ramp[1]:<5.0f} {'yes' if ok else 'COLLISION/CLIP'}")
