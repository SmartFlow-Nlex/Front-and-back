const { chromium } = require("playwright");

(async () => {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1700, height: 1100 } });

  const grab = async (url, h3) => {
    await p.goto(url, { waitUntil: "networkidle", timeout: 120000 });
    await p.getByRole("button", { name: "Predictive", exact: true }).click().catch(() => {});
    await p.waitForTimeout(7000);
    const card = p.locator(`xpath=//h3[contains(., '${h3}')]/ancestor::article[1]`).first();
    await card.waitFor({ state: "visible", timeout: 60000 });
    const t = await card.innerText();
    return t.split("\n").map((l) => l.trim()).filter(Boolean);
  };

  const vol = await grab("http://localhost:3002/dashboard/traffic", "Traffic Volume Walk-Forward");
  const em = await grab("http://localhost:3002/dashboard/sustainability", "Corridor CO");

  const zone = (lines, word) => {
    const i = lines.findIndex((l) => l === word);
    return i < 0 ? "(not found)" : lines.slice(i, i + 2).join("  ");
  };

  console.log("TRAFFIC");
  for (const w of ["Past", "Present", "Future"]) console.log("  " + w.padEnd(8) + zone(vol, w));
  console.log("\nEMISSIONS");
  for (const w of ["Past", "Present", "Future"]) console.log("  " + w.padEnd(8) + zone(em, w));

  await b.close();
})();
