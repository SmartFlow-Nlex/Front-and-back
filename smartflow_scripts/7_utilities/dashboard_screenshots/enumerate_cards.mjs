/** Lists the card headings present on each Traffic sub-tab, so figures are
 *  claimed only for panels that actually exist in this build. */
import { chromium } from "playwright";

const URL = "http://localhost:3002/dashboard/traffic";
const TABS = ["Descriptive", "Predictive", "Prescriptive"];

const b = await chromium.launch();
const pg = await b.newPage({ viewport: { width: 1680, height: 1200 } });
await pg.goto(URL, { waitUntil: "networkidle", timeout: 120000 });
await pg.waitForTimeout(6000);

for (const tab of TABS) {
  try {
    const btn = pg.locator(`button:has-text("${tab}"), [role=tab]:has-text("${tab}")`).first();
    if (await btn.count()) {
      await btn.click();
      await pg.waitForTimeout(7000);
    }
  } catch { /* tab control may differ */ }

  const heads = await pg.evaluate(() => {
    const out = [];
    document.querySelectorAll("h1,h2,h3,h4").forEach((h) => {
      const t = (h.textContent || "").trim();
      if (t && t.length < 90) {
        const r = h.getBoundingClientRect();
        out.push({ tag: h.tagName, text: t, y: Math.round(r.top + window.scrollY) });
      }
    });
    return out;
  });
  console.log(`\n=== ${tab} — ${heads.length} headings ===`);
  heads.forEach((h) => console.log(`  [${h.tag}] y=${String(h.y).padStart(6)}  ${h.text}`));
}

await b.close();
