// Screenshot the rewired CO2 forecast panel at each granularity.
const { chromium } = require("playwright");
const OUT = process.argv[2] || ".";

(async () => {
  const b = await chromium.launch();
  const pg = await b.newPage({ viewport: { width: 1600, height: 1100 }, deviceScaleFactor: 2 });
  const errs = [];
  pg.on("console", (m) => m.type() === "error" && errs.push(m.text()));
  pg.on("pageerror", (e) => errs.push("PAGEERROR " + e.message));

  await pg.goto("http://localhost:3002/dashboard/sustainability", { waitUntil: "networkidle", timeout: 90000 });
  // The panel lives behind the Predictive tab on the emissions page.
  await pg.getByRole("button", { name: "Predictive", exact: true }).click();
  await pg.waitForTimeout(1500);

  const panel = pg.locator("xpath=//h3[contains(., 'Corridor CO')]/ancestor::article[1]");
  await panel.waitFor({ state: "visible", timeout: 60000 });
  await pg.waitForTimeout(3500);

  console.log("HEADER :", await panel.locator("p").first().innerText());
  const spans = (await panel.locator("span").allInnerTexts()).filter((s) => s.trim()).slice(0, 5);
  console.log("BADGE  :", spans.join(" | ").replace(/\n/g, " "));

  for (const g of ["Weekly", "Monthly", "Daily"]) {
    await panel.getByRole("button", { name: g, exact: true }).click();
    await pg.waitForTimeout(2000);
    await panel.screenshot({ path: `${OUT}/co2_forecast_${g.toLowerCase()}.png` });
    console.log("  captured " + g);
  }

  console.log("CONSOLE ERRORS:", errs.length ? errs.slice(0, 5) : "none");
  await b.close();
})();
