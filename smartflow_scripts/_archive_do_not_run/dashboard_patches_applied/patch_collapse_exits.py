raise SystemExit(
    "ARCHIVED - do not run. Edits the dashboard source in place; its change is already applied. Kept only as a record; see smartflow_scripts/README.md.")

import io

p = (r"C:\Users\Hans\.gemini\antigravity\scratch\Front-and-back-Ver1-Merged-BE-FE"
     r"\Front-and-back-Ver1-Merged-BE-FE\Front-End-Dashboard\components\dashboard"
     r"\PredictiveCongestionChart.tsx")
s = io.open(p, encoding="utf-8").read()

pairs = []

pairs.append((
    "  const [alertsOpen, setAlertsOpen] = useState(false);",
    """  const [alertsOpen, setAlertsOpen] = useState(false);
  // Show the southern end first — 20 rows is a lot to land on. Expanding is one
  // click, and the SUMMARY above the grid always covers all 20 regardless, so
  // the collapsed view never changes what the panel reports.
  const [showAllExits, setShowAllExits] = useState(false);
  const COLLAPSED_EXITS = 5;"""))

# Slice for display only. `segments` is reversed for ECharts (index 0 renders at
# the bottom), so the northern-most km sits at the end — the first five by
# km-post are the LAST five of the array.
pairs.append((
    "  const heatHeight = segments.length * ROW_H;",
    """  // Display slice only: `segments` is reversed for ECharts (index 0 draws at
  // the bottom), so the first exits by km-post are the tail of the array.
  const shownSegments = showAllExits ? segments : segments.slice(-COLLAPSED_EXITS);
  const hiddenCount = segments.length - shownSegments.length;
  const yOffset = segments.length - shownSegments.length;
  const shownCells = cells
    .filter((c) => c.value[1] >= yOffset)
    .map((c) => ({ ...c, value: [c.value[0], c.value[1] - yOffset, c.value[2]] as [number, number, number] }));
  // Exits dropped from the view that turn severe SOONER than anything shown —
  // hiding an earlier problem silently would be the one real risk here.
  const earliestShown = Math.min(
    ...shownCells.filter((c) => c.state === "High").map((c) => c.value[0] + 1),
    Number.POSITIVE_INFINITY);
  const urgentHidden = cells.filter(
    (c) => c.value[1] < yOffset && c.state === "High" && c.value[0] + 1 < earliestShown
  ).length > 0;

  const heatHeight = shownSegments.length * ROW_H;"""))

# Everything the chart draws switches to the sliced arrays.
pairs.append(('        data: cells,', '        data: shownCells,'))
pairs.append((
    '''        data: segments.map((s) => `${s}  ·  km ${kmLabel(KMI.get(s))}`),''',
    '''        data: shownSegments.map((s) => `${s}  ·  km ${kmLabel(KMI.get(s))}`),'''))
pairs.append(('        max: segments.length,', '        max: segments.length,'))

# Tooltip indexes into segments by y; it must use the sliced list too.
pairs.append((
    '''            <b style="font-size:1.05em; color:#0f172a;">${segments[y]}</b>
            <span style="color:#94a3b8; font-size:0.85em;"> · km ${kmLabel(KMI.get(segments[y]))}</span>''',
    '''            <b style="font-size:1.05em; color:#0f172a;">${shownSegments[y]}</b>
            <span style="color:#94a3b8; font-size:0.85em;"> · km ${kmLabel(KMI.get(shownSegments[y]))}</span>'''))

# The expand control, directly under the chart.
pairs.append((
    '''      <div style={{ width: "100%", height: `${chartHeight}px` }}>
        <DashboardChart option={option} height={chartHeight} />
      </div>''',
    '''      <div style={{ width: "100%", height: `${chartHeight}px` }}>
        <DashboardChart option={option} height={chartHeight} />
      </div>

      {hiddenCount > 0 && (
        <button
          onClick={() => setShowAllExits(true)}
          style={{
            alignSelf: "flex-start", display: "inline-flex", alignItems: "center", gap: 8,
            padding: "5px 13px", borderRadius: 999, cursor: "pointer",
            border: "1px solid var(--border-default, #dce2ef)", background: "var(--bg-surface, #fff)",
            color: "#475569", fontSize: "0.76rem", fontWeight: 600,
          }}
        >
          Show all {segments.length} exits
          {/* Never hide an earlier problem without saying so. */}
          {urgentHidden && (
            <span style={{ color: "#b45309", fontWeight: 700 }}>
              · {hiddenCount} hidden, some turn severe sooner
            </span>
          )}
        </button>
      )}
      {showAllExits && segments.length > COLLAPSED_EXITS && (
        <button
          onClick={() => setShowAllExits(false)}
          style={{
            alignSelf: "flex-start", padding: "5px 13px", borderRadius: 999, cursor: "pointer",
            border: "1px solid var(--border-default, #dce2ef)", background: "var(--bg-surface, #fff)",
            color: "#475569", fontSize: "0.76rem", fontWeight: 600,
          }}
        >
          Show first {COLLAPSED_EXITS} only
        </button>
      )}'''))

for a, b in pairs:
    assert a in s, "MISSING: " + a[:70]
    s = s.replace(a, b, 1)

io.open(p, "w", encoding="utf-8").write(s)
print("collapsed exit view added")
