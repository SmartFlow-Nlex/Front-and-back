raise SystemExit(
    "ARCHIVED - do not run. Edits the dashboard source in place; its change is already applied. Kept only as a record; see smartflow_scripts/README.md.")

import io

p = (r"C:\Users\Hans\.gemini\antigravity\scratch\Front-and-back-Ver1-Merged-BE-FE"
     r"\Front-and-back-Ver1-Merged-BE-FE\Front-End-Dashboard\components\dashboard\ModelNarrative.tsx")
s = io.open(p, encoding="utf-8").read()

s = s.replace(
    'export type NarrativeModelKey = "LSTM" | "Prophet" | "HoltWinters" | "SARIMAX" | "HoltsLinear";',
    '''export type NarrativeModelKey = string;

/**
 * The volume module's vocabulary. Kept as the DEFAULT so that panel is
 * unaffected, but every map is overridable: the emissions panel forecasts a
 * different quantity with a different model family, and hardcoding one module's
 * model names here would have meant either a second copy of this component or a
 * narrative that named models the reader is not looking at.
 */
export type NarrativeVocab = {
  /** UI key -> model_name as stored in gold.ml_model_metrics */
  dbName: Record<string, string>;
  label: Record<string, string>;
  color: Record<string, string>;
  /** Describes the method, not this run. */
  howItWorks: Record<string, string>;
  /** Models with a weather-free twin, enabling a with/without comparison. */
  noWeatherTwin?: Partial<Record<string, string>>;
  /** Unit suffix for MAE, e.g. "veh" or "t". Omit for none. */
  maeUnit?: string;
  /** How MAE/RMSE are rendered. Volume counts are integers; tonnes are not. */
  fmtMagnitude?: (n: number | null | undefined) => string | null;
};''')

pairs = [
    ('/** UI key -> model_name as stored in gold.ml_model_metrics */\nconst DB_NAME: Record<NarrativeModelKey, string> = {',
     'const DB_NAME: Record<string, string> = {'),
    ('/** Models that were also trained without weather, enabling a with/without comparison */\nconst NO_WEATHER_TWIN: Partial<Record<NarrativeModelKey, string>> = {',
     'const NO_WEATHER_TWIN: Partial<Record<string, string>> = {'),
    ('const COLOR: Record<NarrativeModelKey, string> = {', 'const COLOR: Record<string, string> = {'),
    ('const LABEL: Record<NarrativeModelKey, string> = {', 'const LABEL: Record<string, string> = {'),
    ('const HOW_IT_WORKS: Record<NarrativeModelKey, string> = {', 'const HOW_IT_WORKS: Record<string, string> = {'),
    ('const fmt2 = (n: number | null | undefined) =>',
     '''const VOLUME_VOCAB: NarrativeVocab = {
  dbName: DB_NAME, label: LABEL, color: COLOR, howItWorks: HOW_IT_WORKS,
  noWeatherTwin: NO_WEATHER_TWIN, maeUnit: "veh",
};

const fmt2 = (n: number | null | undefined) =>'''),
    ('''  horizonDays,
}: {
  selected: NarrativeModelKey[];
  metrics: MetricRow[];
  showWeather: boolean;''',
     '''  horizonDays,
  vocab = VOLUME_VOCAB,
  quantityNote,
}: {
  selected: NarrativeModelKey[];
  metrics: MetricRow[];
  showWeather?: boolean;
  /** Model names, colours and descriptions. Defaults to the volume module's. */
  vocab?: NarrativeVocab;
  /** Appended to the closing caveat, for module-specific limitations. */
  quantityNote?: string;'''),
    ('  const byName = new Map(metrics.map((m) => [m.model_name, m]));',
     '''  const { dbName: DBN, label: LBL, color: CLR, howItWorks: HOW } = vocab;
  const TWIN = vocab.noWeatherTwin ?? {};
  const fmtMag = vocab.fmtMagnitude ?? fmtInt;

  const byName = new Map(metrics.map((m) => [m.model_name, m]));'''),
    ('const twin = NO_WEATHER_TWIN[k];', 'const twin = TWIN[k];'),
    ('return byName.get(DB_NAME[k]);', 'return byName.get(DBN[k]);'),
    ('const twinName = NO_WEATHER_TWIN[k];', 'const twinName = TWIN[k];'),
    ('const base = byName.get(DB_NAME[k]);', 'const base = byName.get(DBN[k]);'),
    ('background: COLOR[k] }', 'background: CLR[k] }'),
    ('{LABEL[k]}', '{LBL[k]}'),
    ('{HOW_IT_WORKS[k]}', '{HOW[k]}'),
    ('tone: COLOR[k] }', 'tone: CLR[k] }'),
    ('const mae = fmtInt(r.mae);', 'const mae = fmtMag(r.mae);'),
    ('const rmse = fmtInt(r.rmse);', 'const rmse = fmtMag(r.rmse);'),
    ('stats.push({ label: "MAE", value: `${mae} veh` });',
     'stats.push({ label: "MAE", value: vocab.maeUnit ? `${mae} ${vocab.maeUnit}` : mae });'),
    ('and the Future band is a projection rather than a validated forecast.',
     'and the Future band is a projection rather than a validated forecast.\n        {quantityNote ? <> {quantityNote}</> : null}'),
]

for a, b in pairs:
    assert a in s, "MISSING: " + a[:70]
    s = s.replace(a, b)

io.open(p, "w", encoding="utf-8").write(s)
print("ModelNarrative generalised; volume defaults preserved")
