const { chromium } = require("playwright");
const OUT = process.argv[2];

(async () => {
  const b = await chromium.launch();
  for (const w of [1920, 1500]) {
    const p = await b.newPage({ viewport: { width: w, height: 1200 }, deviceScaleFactor: 1.5 });
    const errs = [];
    p.on("pageerror", (e) => errs.push(e.message));
    await p.goto("http://localhost:3002/dashboard/traffic", { waitUntil: "networkidle", timeout: 120000 });
    await p.getByRole("button", { name: "Predictive", exact: true }).click().catch(() => {});
    await p.waitForTimeout(9000);

    const c = p.locator("xpath=//h3[contains(., 'Predictive Congestion State Map')]/ancestor::article[1]").first();
    const e = p.locator("xpath=//h3[contains(., 'Event Surge Impact')]/ancestor::article[1]").first();
    await c.waitFor({ state: "visible", timeout: 60000 });
    await e.waitFor({ state: "visible", timeout: 60000 });
    const cb = await c.boundingBox();
    const eb = await e.boundingBox();
    const sideBySide = Math.abs(cb.y - eb.y) < 60;
    console.log(`viewport ${w}px -> congestion ${Math.round(cb.width)}px @y${Math.round(cb.y)}, ` +
                `event ${Math.round(eb.width)}px @y${Math.round(eb.y)}  => ${sideBySide ? "SIDE BY SIDE" : "stacked"}`);

    await c.scrollIntoViewIfNeeded();
    await p.waitForTimeout(900);
    await p.screenshot({ path: `${OUT}/side_${w}.png`, fullPage: false });
    console.log("   errors:", errs.length ? errs.slice(0, 2) : "none");
    await p.close();
  }
  await b.close();
})();
