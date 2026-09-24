import type { Paint } from "./vehiclePaint";

/**
 * A motorcycle with its rider, seen from above: two wheels, a shaded tank between them, handlebars across the
 * front, a rider's jacket and a helmet. Drawn in the sprite's own frame — the nose of the vehicle it stands in
 * for at x = 0, the body behind it at negative x, the lane's centre line at y = 0 — inside a slot of `len` x
 * `wid` (the size of the car the engine actually simulates; a motorcycle is smaller than that slot and sits
 * a little behind its nose). Pure drawing: it reads nothing but its arguments, so verify.ts can run it against
 * a recording context and a sprite sheet can be rendered outside the app.
 */
export type BikeCtx = Pick<
  CanvasRenderingContext2D,
  | "beginPath" | "moveTo" | "lineTo" | "arcTo" | "closePath" | "ellipse" | "arc" | "fill" | "stroke" | "fillRect"
  | "createLinearGradient" | "fillStyle" | "strokeStyle" | "lineWidth"
>;

const OUTLINE = "rgba(9,14,28,0.8)";
const HEADLIGHT = "#fff6bf";

function rr(ctx: BikeCtx, x: number, y: number, w: number, h: number, r: number): void {
  const ww = Math.max(0, w);
  const hh = Math.max(0, h);
  const rad = Math.max(0, Math.min(r, ww / 2, hh / 2));
  ctx.beginPath();
  ctx.moveTo(x + rad, y);
  ctx.arcTo(x + ww, y, x + ww, y + hh, rad);
  ctx.arcTo(x + ww, y + hh, x, y + hh, rad);
  ctx.arcTo(x, y + hh, x, y, rad);
  ctx.arcTo(x, y, x + ww, y, rad);
  ctx.closePath();
}

function dot(ctx: BikeCtx, x: number, y: number, r: number): void {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
}

/** Bikes that are pale enough that a slate jacket reads on them; the rest carry an amber one so the rider shows on dark asphalt. */
function paleBody(paint: Paint): boolean {
  return paint.hi === "#ffffff" || paint.hi === "#d3dae4" || paint.hi === "#fff08a" || paint.hi === "#ffc08a";
}

export function drawMotorcycle(ctx: BikeCtx, len: number, wid: number, paint: Paint, braking: boolean): void {
  const bikeLen = Math.max(10, len * 0.95);
  const bodyH = Math.max(2.6, wid * 0.36);
  const front = -len * 0.03;
  const rear = front - bikeLen;
  const jacket = paleBody(paint) ? "#475569" : "#fbbf24";

  // soft shadow
  ctx.fillStyle = "rgba(0,0,0,0.34)";
  rr(ctx, rear + 0.5, -bodyH / 2 + 1.5, bikeLen, bodyH, bodyH / 2);
  ctx.fill();

  // wheels at the two ends, with a lighter tyre wall so they show against the road
  const wheelW = bikeLen * 0.2;
  const wheelH = Math.max(2, wid * 0.28);
  for (const x of [front - wheelW, rear]) {
    ctx.fillStyle = "#0b1020";
    rr(ctx, x, -wheelH / 2, wheelW, wheelH, wheelH / 2);
    ctx.fill();
    ctx.strokeStyle = "rgba(203,213,225,0.6)";
    ctx.lineWidth = 0.6;
    ctx.stroke();
  }

  // the body between the wheels: a long thin capsule, shaded like the cars (tank in front, seat behind the rider)
  const g = ctx.createLinearGradient(0, -bodyH / 2, 0, bodyH / 2);
  g.addColorStop(0, paint.hi);
  g.addColorStop(1, paint.lo);
  ctx.fillStyle = g;
  rr(ctx, rear + wheelW * 0.55, -bodyH / 2, bikeLen - wheelW * 1.1, bodyH, bodyH / 2);
  ctx.fill();
  ctx.strokeStyle = paint.edge ?? OUTLINE;
  ctx.lineWidth = 0.8;
  ctx.stroke();

  // handlebars across the front, and the rider's arms reaching them
  const barX = front - wheelW * 0.9;
  const shoulderX = rear + bikeLen * 0.46;
  ctx.fillStyle = "#111827";
  ctx.fillRect(barX - 0.5, -wid * 0.31, Math.max(1.1, len * 0.07), wid * 0.62);
  ctx.strokeStyle = jacket;
  ctx.lineWidth = Math.max(1, wid * 0.11);
  for (const side of [-1, 1]) {
    ctx.beginPath();
    ctx.moveTo(shoulderX + bikeLen * 0.05, side * wid * 0.27);
    ctx.lineTo(barX + 0.3, side * wid * 0.31);
    ctx.stroke();
  }

  // the rider seen from above: shoulders across the bike, a helmet on top
  ctx.fillStyle = jacket;
  ctx.beginPath();
  ctx.ellipse(shoulderX, 0, bikeLen * 0.11, wid * 0.4, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = "rgba(226,232,240,0.65)";
  ctx.lineWidth = 0.7;
  ctx.stroke();
  ctx.fillStyle = "#f8fafc";
  dot(ctx, shoulderX + bikeLen * 0.03, 0, Math.max(1.6, wid * 0.2));
  ctx.fillStyle = "rgba(15,23,42,0.85)";
  dot(ctx, shoulderX + bikeLen * 0.08, 0, Math.max(0.7, wid * 0.08));

  // headlight and tail light (lit and glowing when braking)
  ctx.fillStyle = HEADLIGHT;
  dot(ctx, front + 0.1, 0, Math.max(1, wid * 0.11));
  if (braking) {
    ctx.fillStyle = "rgba(255,50,50,0.4)";
    ctx.fillRect(rear - 1.8, -1.6, 3.4, 3.2);
  }
  ctx.fillStyle = braking ? "#ff2a2a" : "#8f1d1d";
  ctx.fillRect(rear - 0.4, -1, 1.7, 2);
}
