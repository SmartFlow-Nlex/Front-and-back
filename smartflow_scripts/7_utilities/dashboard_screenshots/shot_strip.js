const { chromium } = require("playwright");
const OUT = process.argv[2];

(async () => {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1700, height: 1100 }, deviceScaleFactor: 2 });
  const errs = [];
  p.on("pageerror", (e) => errs.push(e.message));
  await p.goto("http://localhost:3002/dashboard/traffic", { waitUntil: "networkidle", timeout: 120000 });
  await p.getByRole("button", { name: "Predictive", exact: true }).click().catch(() => {});
  await p.waitForTimeout(9000);
  const c = p.locator("xpath=//h3[contains(., 'Predictive Congestion State Map')]/ancestor::article[1]").first();
  await c.waitFor({ state: "visible", timeout: 60000 });
  const bb = await c.boundingBox();
  // Scroll the strip into view, then clip relative to the viewport.
  await c.scrollIntoViewIfNeeded();
  await p.waitForTimeout(1200);
  const box = await c.boundingBox();
  const y = Math.max(0, Math.min(box.y + box.height - 330, 1100 - 310));
  await p.screenshot({ path: `${OUT}/strip_final.png`,
    clip: { x: box.x, y: Math.max(0, Math.min(box.y + box.height - 300, 1100 - 290)), width: box.width, height: 290 } });
  console.log("card height:", Math.round(bb.height));
  console.log("ERRS:", errs.length ? errs.slice(0, 2) : "none");
  await b.close();
})();
