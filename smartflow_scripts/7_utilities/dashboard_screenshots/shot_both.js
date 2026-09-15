// Capture the rebuilt emissions panel AND the volume panel, to confirm the
// shared ModelNarrative change did not disturb the volume module.
const { chromium } = require("playwright");
const OUT = process.argv[2] || ".";

(async () => {
  const b = await chromium.launch();
  const pg = await b.newPage({ viewport: { width: 1700, height: 1400 }, deviceScaleFactor: 2 });
  const errs = [];
  pg.on("console", (m) => m.type() === "error" && errs.push(m.text()));
  pg.on("pageerror", (e) => errs.push("PAGEERROR " + e.message));

  // ---- Emissions ----
  await pg.goto("http://localhost:3002/dashboard/sustainability", { waitUntil: "networkidle", timeout: 90000 });
  await pg.getByRole("button", { name: "Predictive", exact: true }).click();
  await pg.waitForTimeout(1500);
  const em = pg.locator("xpath=//h3[contains(., 'Corridor CO')]/ancestor::article[1]");
  await em.waitFor({ state: "visible", timeout: 60000 });
  await pg.waitForTimeout(3000);

  console.log("== EMISSIONS ==");
  console.log("title  :", await em.locator("h3").first().innerText());
  console.log("sub    :", await em.locator("p").first().innerText());

  await em.screenshot({ path: `${OUT}/em_weekly.png` });

  // Turn all three model lines on
  for (const m of ["Gradient Boosting", "LSTM"]) {
    await em.getByRole("button", { name: new RegExp("^" + m) }).click();
    await pg.waitForTimeout(700);
  }
  await pg.waitForTimeout(1200);
  await em.screenshot({ path: `${OUT}/em_all_models.png` });
  const rows = await em.locator("tbody tr").count();
  console.log("metric rows with 3 models selected:", rows);

  // Expand the narrative
  await em.getByRole("button", { name: "Generate report" }).click();
  await pg.waitForTimeout(1200);
  await em.screenshot({ path: `${OUT}/em_narrative.png` });
  console.log("narrative opened OK");

  // ---- Volume (regression check) ----
  await pg.goto("http://localhost:3002/dashboard/traffic", { waitUntil: "networkidle", timeout: 90000 });
  await pg.getByRole("button", { name: "Predictive", exact: true }).click().catch(() => {});
  await pg.waitForTimeout(3000);
  const vol = pg.locator("xpath=//h3[contains(., 'Walk-Forward')]/ancestor::article[1]").first();
  const n = await vol.count();
  console.log("\n== VOLUME ==");
  if (n) {
    await vol.waitFor({ state: "visible", timeout: 60000 });
    await pg.waitForTimeout(2500);
    console.log("title  :", await vol.locator("h3").first().innerText());
    await vol.getByRole("button", { name: "Generate report" }).click().catch(() => {});
    await pg.waitForTimeout(1200);
    await vol.screenshot({ path: `${OUT}/vol_narrative.png` });
    const txt = await vol.innerText();
    console.log("narrative mentions Prophet:", txt.includes("Prophet"));
    console.log("MAE unit still 'veh':", /MAE\s+[\d,]+\s*veh/.test(txt.replace(/\n/g, " ")));
  } else {
    console.log("volume panel not found on /dashboard/traffic");
  }

  console.log("\nCONSOLE ERRORS:", errs.length ? errs.slice(0, 6) : "none");
  await b.close();
})();
