raise SystemExit(
    "ARCHIVED - do not run. Edits the dashboard source in place; its change is already applied. Kept only as a record; see smartflow_scripts/README.md.")

import io

p = (r"C:\Users\Hans\.gemini\antigravity\scratch\Front-and-back-Ver1-Merged-BE-FE"
     r"\Front-and-back-Ver1-Merged-BE-FE\Front-End-Dashboard\components\dashboard"
     r"\PredictiveCongestionChart.tsx")
s = io.open(p, encoding="utf-8").read()

pairs = []

# ── 1. Derive the facts a reader actually wants ──────────────────────────────
pairs.append((
    """    const peakIdx = perHour.indexOf(Math.max(...perHour));""",
    """    // The grid's real message is usually not "cell (3,7) is red" but "a run of
    // neighbouring exits is bad for a long stretch". Congestion propagates
    // between neighbours, so a CONTIGUOUS block is the meaningful shape - and it
    // is far quicker to read as one sentence than as 240 coloured cells.
    const severeIdx = segments
      .map((seg, i) => (severeSegments.has(seg) ? i : -1))
      .filter((i) => i >= 0)
      .sort((a, b) => a - b);
    const contiguous =
      severeIdx.length > 1 && severeIdx[severeIdx.length - 1] - severeIdx[0] === severeIdx.length - 1;
    const severeKms = [...severeSegments]
      .map((seg) => KMI.get(seg)?.km)
      .filter((k): k is number => k != null)
      .sort((a, b) => a - b);
    const kmFrom = severeKms.length ? severeKms[0] : null;
    const kmTo = severeKms.length ? severeKms[severeKms.length - 1] : null;

    // Every hour identical means the 12 columns carry no information, and a
    // "peak window" label would invent a worst hour that does not exist.
    const flatHours = perHour.length > 1 && perHour.every((n) => n === perHour[0]);

    // How long the worst segments stay bad, and how sure the model is.
    const severeAlerts = alerts.filter((a) => a.state === "High");
    const allHours =
      severeAlerts.length > 0 &&
      severeAlerts.every((a) => a.from === 1 && a.to === maxHour);
    const severeConfs = severeAlerts.map((a) => a.conf).sort((x, y) => x - y);

    const peakIdx = perHour.indexOf(Math.max(...perHour));"""))

pairs.append((
    """      firstSevere,
      lowConfCount: cells.filter((c) => c.state !== "Low" && c.conf < LOW_CONF).length,""",
    """      firstSevere,
      contiguous,
      kmFrom,
      kmTo,
      flatHours,
      allHours,
      maxHour,
      confLo: severeConfs.length ? severeConfs[0] : null,
      confHi: severeConfs.length ? severeConfs[severeConfs.length - 1] : null,
      // Whether the model EVER predicts Heavy. It does not, and a legend entry
      // for a state that never appears reads as a gap in the data rather than a
      // property of the model.
      everHeavy: cells.some((c) => c.state === "Med"),
      lowConfCount: cells.filter((c) => c.state !== "Low" && c.conf < LOW_CONF).length,"""))

# ── 2. Label only where a run STARTS ────────────────────────────────────────
pairs.append((
    """      const meta = STATE_META[d.state] ?? STATE_META.Low;
      cells.push({ value: [x, y, meta.rank], state: d.state, conf, label: { color: meta.text } });""",
    """      const meta = STATE_META[d.state] ?? STATE_META.Low;
      cells.push({ value: [x, y, meta.rank], state: d.state, conf, label: { color: meta.text } });"""))

pairs.append((
    """          formatter: (params: unknown) => {
            const d = (params as { data: CellItem }).data;
            if (d.state === "Low") return "";
            return d.conf < LOW_CONF ? `${STATE_META[d.state].short}*` : STATE_META[d.state].short;
          },""",
    """          // The word was printed in EVERY cell of a run, so a segment that is
          // severe for twelve straight hours rendered "SEVERE*" twelve times.
          // Sixty repetitions of one word is noise, and it buried the thing that
          // matters - WHERE the bad stretch starts. Now only the first cell of a
          // run is labelled; the colour already carries the state, and the
          // tooltip carries the confidence.
          formatter: (params: unknown) => {
            const d = (params as { data: CellItem }).data;
            if (d.state === "Low" || !d.runStart) return "";
            return d.conf < LOW_CONF ? `${STATE_META[d.state].short}*` : STATE_META[d.state].short;
          },"""))

pairs.append((
    """type CellItem = { value: [number, number, number]; state: State; conf: number; label: { color: string } };""",
    """type CellItem = {
  value: [number, number, number];
  state: State;
  conf: number;
  /** First cell of a contiguous run of this state — the only one that is labelled. */
  runStart?: boolean;
  label: { color: string };
};"""))

# Mark run starts once the states grid is complete.
pairs.append((
    """    // ---- Operational summary ----
    const atRisk = new Set<string>();""",
    """    // Flag the first cell of each run so the label formatter can print the state
    // once per run instead of once per cell.
    cells.forEach((c) => {
      const [x, y] = c.value;
      c.runStart = x === 0 || states[y][x - 1] !== c.state;
    });

    // ---- Operational summary ----
    const atRisk = new Set<string>();"""))

# ── 3. Plain-language headline ──────────────────────────────────────────────
pairs.append((
    """  const headline = model.firstSevere
    ? `${model.severeSegments.join(" and ")} ${model.severeSegments.length > 1 ? "are" : "is"} forecast to hit severe congestion — first at ${model.firstSevere.segment}, +${model.firstSevere.from}h. The corridor is busiest at +${model.peakHour}h with ${model.peakHourCount} of ${segments.length} segments congested.`
    : `No severe congestion forecast in the next ${hourLabels.length} hours. Busiest window is +${model.peakHour}h with ${model.peakHourCount} of ${segments.length} segments running heavy.`;""",
    """  // "A and B and C and D and E are forecast to hit severe congestion" made the
  // reader assemble the picture from a list. The shape of the problem - one
  // unbroken stretch of road, bad for the whole window - is the thing to say.
  const nSevere = model.severeSegments.length;
  const kmSpan =
    model.kmFrom != null && model.kmTo != null ? Math.round(model.kmTo - model.kmFrom) : null;
  const whenText = model.allHours
    ? `for the whole ${model.maxHour}-hour window`
    : `starting +${model.firstSevere?.from}h`;

  const headline = !model.firstSevere
    ? `No severe congestion forecast in the next ${hourLabels.length} hours.`
    : model.contiguous && kmSpan != null
    ? `One unbroken stretch is forecast severe: ${nSevere} neighbouring exits from ${model.severeSegments
        .map((sg) => ({ sg, km: KMI.get(sg)?.km ?? 0 }))
        .sort((a, b) => a.km - b.km)[0].sg} (km ${model.kmFrom}) to ${model.severeSegments
        .map((sg) => ({ sg, km: KMI.get(sg)?.km ?? 0 }))
        .sort((a, b) => b.km - a.km)[0].sg} (km ${model.kmTo}) — about ${kmSpan} km — ${whenText}. The rest of the corridor stays free-flowing.`
    : `${nSevere} of ${segments.length} exits are forecast severe ${whenText}: ${model.severeSegments.join(", ")}.`;"""))

# ── 4. KPIs that do not repeat the sentence above them ──────────────────────
pairs.append((
    """        {kpi("Severe risk", `${model.severeSegments.length} of ${segments.length}`, `segments · ${model.severeCells} hours below 30 km/h`, model.severeSegments.length > 0 ? "#b91c1c" : "#15803d")}
        {kpi("Peak risk window", model.peakHour ? `+${model.peakHour}h` : "—", model.peakHour ? `${model.peakHourCount} of ${segments.length} segments congested` : "no congestion predicted")}
        {kpi("Most-affected segment", model.worstSegment ?? "—", model.worstSegment ? `${model.worstSegmentCount} of ${hourLabels.length} hours at risk` : "—")}
        {kpi("Heavy or worse", `${model.atRisk} of ${segments.length}`, "segments congested at some point", model.atRisk > 0 ? "#b45309" : "#15803d")}""",
    """        {/* Previously four cards, three of which restated the sentence above and
            two of which showed the SAME number ("Severe risk 5 of 20" and "Heavy
            or worse 5 of 20") because the model never predicts Heavy. These
            answer different questions: how many, where, how long, how sure. */}
        {kpi("Exits affected", `${model.severeSegments.length} of ${segments.length}`,
             model.severeSegments.length > 0 ? "forecast below 30 km/h" : "corridor is clear",
             model.severeSegments.length > 0 ? "#b91c1c" : "#15803d")}
        {kpi("Where", kmSpan != null ? `km ${model.kmFrom}–${model.kmTo}` : "—",
             kmSpan != null
               ? `${kmSpan} km${model.contiguous ? " · one unbroken stretch" : " · not contiguous"}`
               : "no congestion predicted")}
        {kpi("How long", model.allHours ? `all ${model.maxHour}h` : model.worstSegment ? `${model.worstSegmentCount} of ${hourLabels.length}h` : "—",
             model.flatHours ? "same every hour — no peak window" : "varies by hour")}
        {kpi("Model confidence",
             model.confLo != null && model.confHi != null
               ? `${Math.round(model.confLo * 100)}–${Math.round(model.confHi * 100)}%`
               : "—",
             model.confLo != null && model.confLo < LOW_CONF ? "below the 80% mark — treat as indicative" : "on the severe predictions",
             model.confLo != null && model.confLo < LOW_CONF ? "#b45309" : undefined)}"""))

# ── 5. Subtitle and legend ──────────────────────────────────────────────────
pairs.append((
    """            Each cell is one segment at one hour ahead · rows run north-bound by km-post · hover for model confidence""",
    """            Forecast road state for the next {hourLabels.length} hours · one row per exit, ordered
            north-bound down the corridor · one column per hour ahead · hover any cell for the model&apos;s
            confidence"""))

pairs.append((
    """          {(["Low", "Med", "High"] as State[]).map((s) => (
            <span key={s} style={{ display: "inline-flex", alignItems: "center", gap: "6px", whiteSpace: "nowrap" }}>
              <span style={{ width: 13, height: 13, background: STATE_META[s].color, borderRadius: "3px" }} />
              {STATE_META[s].label} <span style={{ color: "#94a3b8" }}>({STATE_META[s].speed})</span>
            </span>
          ))}""",
    """          {(["Low", "Med", "High"] as State[]).map((s) => {
            // Heavy is in the legend but this model never predicts it, so an
            // unexplained swatch reads as missing data rather than as a known
            // limitation. Say so instead of letting the reader wonder.
            const absent = s === "Med" && !model.everHeavy;
            return (
              <span
                key={s}
                title={absent ? "This model never predicts Heavy — it was trained on jam-only data and cannot separate the middle state" : undefined}
                style={{
                  display: "inline-flex", alignItems: "center", gap: "6px",
                  whiteSpace: "nowrap", opacity: absent ? 0.45 : 1,
                }}
              >
                <span style={{ width: 13, height: 13, background: STATE_META[s].color, borderRadius: "3px" }} />
                {STATE_META[s].label} <span style={{ color: "#94a3b8" }}>({STATE_META[s].speed})</span>
                {absent && <span style={{ color: "#94a3b8", fontStyle: "italic" }}>· never predicted</span>}
              </span>
            );
          })}"""))

for a, b in pairs:
    assert a in s, "MISSING: " + a[:90]
    s = s.replace(a, b, 1)

io.open(p, "w", encoding="utf-8").write(s)
print("congestion panel clarified")
