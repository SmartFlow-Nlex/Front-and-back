"""Screenshot the rewired CO2 forecast panel, at each granularity."""
import sys
from playwright.sync_api import sync_playwright

OUT = sys.argv[1] if len(sys.argv) > 1 else "."

with sync_playwright() as pw:
    b = pw.chromium.launch()
    pg = b.new_page(viewport={"width": 1600, "height": 1100}, device_scale_factor=2)
    errs = []
    pg.on("console", lambda m: errs.append(m.text) if m.type == "error" else None)
    pg.on("pageerror", lambda e: errs.append(f"PAGEERROR {e}"))

    pg.goto("http://localhost:3002/dashboard/sustainability", wait_until="networkidle", timeout=90000)
    panel = pg.locator("xpath=//h3[contains(., 'Corridor CO')]/ancestor::article[1]")
    panel.wait_for(state="visible", timeout=60000)
    pg.wait_for_timeout(3500)

    print("HEADER :", panel.locator("p").first.inner_text())
    print("BADGE  :", " | ".join(panel.locator("span").all_inner_texts()[:4]))

    for gran in ["Weekly", "Monthly", "Daily"]:
        panel.get_by_role("button", name=gran, exact=True).click()
        pg.wait_for_timeout(2000)
        panel.screenshot(path=f"{OUT}/co2_forecast_{gran.lower()}.png")
        print(f"  captured {gran}")

    print("CONSOLE ERRORS:", errs[:5] if errs else "none")
    b.close()
