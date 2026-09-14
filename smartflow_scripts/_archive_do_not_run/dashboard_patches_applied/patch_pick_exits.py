raise SystemExit(
    "ARCHIVED - do not run. Edits the dashboard source in place; its change is already applied. Kept only as a record; see smartflow_scripts/README.md.")

import io

p = (r"C:\Users\Hans\.gemini\antigravity\scratch\Front-and-back-Ver1-Merged-BE-FE"
     r"\Front-and-back-Ver1-Merged-BE-FE\Front-End-Dashboard\components\dashboard"
     r"\PredictiveCongestionChart.tsx")
s = io.open(p, encoding="utf-8").read()

pairs = []

pairs.append((
    """  const [showAllExits, setShowAllExits] = useState(false);
  const COLLAPSED_EXITS = 5;""",
    """  // Which exits beyond the default five are on screen. A set rather than a
  // boolean, so a reader can pull in the two or three exits they care about
  // instead of choosing between five rows and twenty.
  const [extraExits, setExtraExits] = useState<string[]>([]);
  const COLLAPSED_EXITS = 5;"""))

# Arbitrary subsets need an index map, not a simple offset.
pairs.append((
    """  // Display slice only: `segments` is reversed for ECharts (index 0 draws at
  // the bottom), so the first exits by km-post are the tail of the array.
  const shownSegments = showAllExits ? segments : segments.slice(-COLLAPSED_EXITS);
  const hiddenCount = segments.length - shownSegments.length;
  const yOffset = segments.length - shownSegments.length;
  const shownCells = cells
    .filter((c) => c.value[1] >= yOffset)
    .map((c) => ({ ...c, value: [c.value[0], c.value[1] - yOffset, c.value[2]] as [number, number, number] }));""",
    """  // Display slice only: `segments` is reversed for ECharts (index 0 draws at
  // the bottom), so the first exits by km-post are the tail of the array.
  const defaultShown = segments.slice(-COLLAPSED_EXITS);
  const shownSegments = segments.filter(
    (sg) => defaultShown.includes(sg) || extraExits.includes(sg));
  const hiddenSegments = segments.filter((sg) => !shownSegments.includes(sg));
  const hiddenCount = hiddenSegments.length;

  // Arbitrary subsets, so cells are remapped through an index table rather than
  // shifted by a fixed offset.
  const yMap = new Map(shownSegments.map((sg, i) => [segments.indexOf(sg), i]));
  const shownCells = cells
    .filter((c) => yMap.has(c.value[1]))
    .map((c) => ({ ...c, value: [c.value[0], yMap.get(c.value[1])!, c.value[2]] as [number, number, number] }));

  // When does each hidden exit first turn severe? Drives the chip ordering and
  // the warning, so the reader can see which are worth pulling in.
  const firstSevere = (sg: string) => {
    const y = segments.indexOf(sg);
    const hrs = cells.filter((c) => c.value[1] === y && c.state === "High").map((c) => c.value[0] + 1);
    return hrs.length ? Math.min(...hrs) : null;
  };"""))

pairs.append((
    """  const urgentHidden = cells.filter(
    (c) => c.value[1] < yOffset && c.state === "High" && c.value[0] + 1 < earliestShown
  ).length > 0;""",
    """  const urgentHidden = hiddenSegments.some((sg) => {
    const f = firstSevere(sg);
    return f != null && f < earliestShown;
  });"""))

# Replace the two blunt buttons with per-exit chips.
old_buttons = s[s.index("      {hiddenCount > 0 && (\n        <button"):s.index("      {/* Bottleneck cards", s.index("      {hiddenCount > 0 && (\n        <button"))] \
    if "      {/* Bottleneck cards" in s else None
start = s.index("      {hiddenCount > 0 && (\n        <button")
end = s.index("\n", s.index("Show first {COLLAPSED_EXITS} only"))
end = s.index("      )}\n", end) + len("      )}\n")
pairs.append((s[start:end], """      {/* Per-exit chips. "Show all 20" was all-or-nothing; usually a reader
          wants the default five plus the two or three exits they are
          responsible for. Ordered by how soon each turns severe, so the ones
          worth adding surface first. */}
      {(hiddenCount > 0 || extraExits.length > 0) && (
        <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
          <span style={{ fontSize: "0.72rem", color: "#94a3b8", fontWeight: 600, marginRight: 2 }}>
            Add exit
            {urgentHidden && (
              <span style={{ color: "#b45309" }}> · some hidden turn severe sooner</span>
            )}
          </span>

          {[...hiddenSegments]
            .sort((a, b) => (firstSevere(a) ?? 99) - (firstSevere(b) ?? 99))
            .map((sg) => {
              const f = firstSevere(sg);
              const early = f != null && f < earliestShown;
              return (
                <button
                  key={sg}
                  onClick={() => setExtraExits((cur) => [...cur, sg])}
                  title={f ? `Turns severe at +${f}h` : "Stays clear across the window"}
                  style={{
                    padding: "3px 9px", borderRadius: 999, cursor: "pointer", fontSize: "0.71rem",
                    fontWeight: 600, background: "var(--bg-surface, #fff)",
                    border: `1px solid ${early ? "#fcd9a4" : "var(--border-default, #dce2ef)"}`,
                    color: early ? "#b45309" : "#64748b",
                  }}
                >
                  + {sg}
                  {f != null && <span style={{ opacity: 0.7 }}> · +{f}h</span>}
                </button>
              );
            })}

          {hiddenCount > 0 && (
            <button
              onClick={() => setExtraExits(hiddenSegments)}
              style={{
                padding: "3px 9px", borderRadius: 999, cursor: "pointer", fontSize: "0.71rem",
                fontWeight: 700, background: "var(--bg-surface, #fff)",
                border: "1px solid var(--border-default, #dce2ef)", color: "#475569",
              }}
            >
              All {segments.length}
            </button>
          )}
          {extraExits.length > 0 && (
            <button
              onClick={() => setExtraExits([])}
              style={{
                padding: "3px 9px", borderRadius: 999, cursor: "pointer", fontSize: "0.71rem",
                fontWeight: 600, background: "transparent", border: "none", color: "#94a3b8",
              }}
            >
              reset
            </button>
          )}
        </div>
      )}
"""))

for a, b in pairs:
    assert a in s, "MISSING: " + a[:70]
    s = s.replace(a, b, 1)

io.open(p, "w", encoding="utf-8").write(s)
print("per-exit chips added")
