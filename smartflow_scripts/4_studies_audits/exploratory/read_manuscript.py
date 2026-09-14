"""Pull every statement in the manuscript that bears on the train/test split."""
import re
import PyPDF2

import sys as _sys
from pathlib import Path as _Path
_sys.path.insert(0, str(_Path(__file__).resolve().parents[2] / "config"))
from db import setting  # noqa: E402
PDF = setting("MANUSCRIPT_PDF", required=True)   # set in config/.env

PATTERNS = {
    "split ratio":   r'\b(80|70|75|90)\s*[/:\-]\s*(20|30|25|10)\b|\b(eighty|seventy)\b',
    "train/test":    r'\btrain(ing)?\b.{0,60}\b(test(ing)?|valid)',
    "holdout":       r'\bhold[- ]?out\b',
    "cross-val":     r'\bcross[- ]valid|k-?fold|rolling[- ]origin|walk[- ]forward',
    "percent split": r'\b\d{2}\s*(%|percent)\b.{0,50}\b(train|test|valid|split)',
    "data period":   r'\b(20(19|20|21|22|23|24|25|26))\b.{0,30}\b(20(19|20|21|22|23|24|25|26))\b',
    "models":        r'\b(SARIMA|SARIMAX|Prophet|LSTM|Holt|XGBoost|GRU|ARIMA)\b',
    "metrics":       r'\b(MAPE|WMAPE|RMSE|MASE|MAE|R2|R\^2|R²)\b',
}

with open(PDF, "rb") as fh:
    rd = PyPDF2.PdfReader(fh)
    print(f"pages: {len(rd.pages)}\n")
    pages = []
    for i, pg in enumerate(rd.pages):
        try:
            pages.append((i + 1, pg.extract_text() or ""))
        except Exception:
            pages.append((i + 1, ""))

hits = {k: [] for k in PATTERNS}
for pno, text in pages:
    if not text:
        continue
    flat = re.sub(r"\s+", " ", text)
    for sent in re.split(r"(?<=[.;:])\s+", flat):
        for k, pat in PATTERNS.items():
            if re.search(pat, sent, re.I):
                s = sent.strip()
                if 25 < len(s) < 400:
                    hits[k].append((pno, s))

for k in ["split ratio", "percent split", "train/test", "holdout", "cross-val"]:
    v = hits[k]
    print("=" * 74)
    print(f"  {k.upper()}  — {len(v)} match(es)")
    print("=" * 74)
    seen = set()
    for pno, s in v:
        if s in seen:
            continue
        seen.add(s)
        print(f"  p{pno}: {s}\n")
    if not v:
        print("  (none found)\n")

print("=" * 74)
print("  MODELS NAMED")
print("=" * 74)
mods = {}
for pno, s in hits["models"]:
    for m in re.findall(PATTERNS["models"], s, re.I):
        name = m[0] if isinstance(m, tuple) else m
        mods.setdefault(name.title(), set()).add(pno)
for m, ps in sorted(mods.items(), key=lambda x: -len(x[1])):
    print(f"  {m:<10} on {len(ps)} page(s): {sorted(ps)[:12]}")

print("\n" + "=" * 74)
print("  METRICS NAMED")
print("=" * 74)
mets = {}
for pno, s in hits["metrics"]:
    for m in re.findall(PATTERNS["metrics"], s, re.I):
        mets.setdefault(m.upper(), set()).add(pno)
for m, ps in sorted(mets.items(), key=lambda x: -len(x[1])):
    print(f"  {m:<8} on {len(ps)} page(s): {sorted(ps)[:12]}")
