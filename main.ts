// Leonida Week-One Forecast — entry for gta6-trophy-rarity-forecast-01.
//
// Forecasts, for every GTA VI PS5 trophy, its earn rate on Exophase at the
// case's target, as five quantiles (levels 0.05/0.25/0.5/0.75/0.95).
//
// The model is built from what the launch night actually showed, not from the
// house baseline's "rates stay put" guess:
//
//   * The tracked population is the story. Exophase refreshed its counts once
//     on launch night: 638 players tracked became 3,868, and almost every
//     rate fell, because the new cohort had barely played. A rate is
//     earners / players-tracked, so the model forecasts EARNERS and PLAYERS
//     separately and divides, instead of extrapolating the rate itself.
//   * Earners only grow. New earners come from two places: players already
//     tracked who progress (a per-trophy daily hazard, estimated from the
//     history where it shows, else a researched prior), and players newly
//     tracked, who arrive with their own earn rate (estimated from the
//     refresh jumps in the history; at launch the first refresh showed the
//     new cohort at ~30% of the current rate for Chapter 1, ~50% for the
//     fishing challenge, ~5% for late-story trophies and ~0% for the
//     platinum and the grinds).
//   * Players-tracked grows. Its growth is fitted from the history (log
//     players against time, damped), with a refresh prior as a floor: early
//     after release Exophase refreshes every few hours and each refresh
//     multiplies the tracked population several-fold; that prior decays as
//     the game ages.
//   * A logit trend (rate against ln(1 + hours since release), recency
//     weighted, slope shrunk) is a second opinion, and a researched
//     week-one level per trophy is a third: GTA V's long-run shape (its
//     platinum sits near 2% of tracked players after years, its intro
//     trophy near 95% of owners, full completion near 5%) scaled to one
//     week in, per trophy type — story chapters fast, collectibles and
//     grinds slow, the platinum and 100% completion barely moved.
//   * The three opinions are blended in logit space, with weights that
//     follow how much real movement the history shows. The spread is
//     honest: wide when the history is flat (a refresh can move every rate
//     a lot), when the population is about to jump, or when the three
//     opinions disagree; narrow for the intro trophy everybody earns.
//
// Everything the model knows is a constant in this file: the grader's
// sandbox has no network. The program is deterministic (no randomness, no
// clock reads) and runs in milliseconds.
//
// Usage (from the kit directory):
//   mkdir -p out && MAKEFUN_INPUT_DIR=input MAKEFUN_OUTPUT_DIR=out node main.ts

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

/** The game's release, the clock every time in this file is measured from. */
const RELEASE_MS = Date.parse('2026-11-19T00:00:00Z');
/** One week after release, the horizon the researched priors are set for. */
const WEEK_HOURS = 168;
/** The quantile levels the contest scores, in the order each row lists them. */
const LEVELS = [0.05, 0.25, 0.5, 0.75, 0.95];
/** The standard normal's quantile at each level (Acklam's approximation fills any other level). */
const Z_STD = [-1.6448536269514722, -0.6744897501960817, 0, 0.6744897501960817, 1.6448536269514722];

interface Trophy {
  id: number;
  name: string;
  description: string;
  tier: string;
  points: number;
  secret: boolean;
}

interface Read {
  at: string;
  players_tracked: number;
  trophies_earned: number;
  rates: Array<number | null>;
}

interface Case {
  id: string;
  at: string;
  horizon_minutes: number;
  target?: string;
  levels?: number[];
  game?: { name: string; platform: string; release_date: string; source: string };
  trophies: Trophy[];
  history: Read[];
  notes?: string;
}

/**
 * Per-trophy researched constants, keyed by Exophase id (1 = platinum):
 * [week-one earn rate in percent, new-joiner earn rate as a fraction of the
 * current rate, daily progression hazard for players already tracked].
 * Sources: the launch night's own numbers (the 638 -> 3,868 refresh showed
 * the new cohort's earn rates directly), GTA V's long-run shape on
 * PSNProfiles/PSN100 (platinum ~2% of tracked players, intro ~95% of
 * owners, full completion ~5%), and each trophy's description.
 */
const TABLE: Record<number, [number, number, number]> = {
  1: [0.8, 0.0, 0.005], 2: [98.0, 0.98, 2.0], 3: [68, 0.3, 0.35],
  4: [55, 0.08, 0.22], 5: [45, 0.08, 0.15], 6: [38, 0.08, 0.12],
  7: [22, 0.08, 0.08], 8: [42, 0.08, 0.14], 9: [40, 0.08, 0.13],
  10: [38, 0.08, 0.12], 11: [35, 0.08, 0.11], 12: [33, 0.08, 0.1],
  13: [30, 0.08, 0.1], 14: [0.5, 0.0, 0.003], 15: [3, 0.0, 0.01],
  16: [30, 0.06, 0.12], 17: [4, 0.0, 0.01], 18: [6, 0.02, 0.03],
  19: [15, 0.04, 0.06], 20: [35, 0.5, 0.25], 21: [25, 0.3, 0.15],
  22: [25, 0.03, 0.08], 23: [24, 0.03, 0.08], 24: [23, 0.03, 0.08],
  25: [12, 0.02, 0.04], 26: [22, 0.03, 0.08], 27: [21, 0.03, 0.08],
  28: [6, 0.0, 0.03], 29: [15, 0.03, 0.05], 30: [4, 0.0, 0.02],
  31: [3, 0.0, 0.015], 32: [12, 0.02, 0.05], 33: [20, 0.04, 0.07],
  34: [15, 0.04, 0.06], 35: [25, 0.2, 0.08], 36: [18, 0.04, 0.07],
  37: [12, 0.04, 0.05], 38: [10, 0.04, 0.04], 39: [10, 0.04, 0.04],
  40: [8, 0.01, 0.03], 41: [15, 0.04, 0.06], 42: [12, 0.03, 0.04],
  43: [8, 0.02, 0.03], 44: [12, 0.05, 0.05], 45: [10, 0.04, 0.04],
  46: [12, 0.04, 0.05], 47: [12, 0.04, 0.05], 48: [14, 0.04, 0.05],
  49: [12, 0.04, 0.05], 50: [12, 0.04, 0.05], 51: [12, 0.04, 0.05],
  52: [8, 0.02, 0.03], 53: [12, 0.03, 0.05], 54: [10, 0.03, 0.03],
  55: [18, 0.03, 0.06],
};

/** Fallback constants for a trophy id the table does not know, by tier and description. */
function fallback(t: Trophy): [number, number, number] {
  const d = `${t.name} ${t.description}`.toLowerCase();
  if (t.tier === 'platinum') return [0.8, 0.0, 0.005];
  if (/final mission|complete chapter|complete the final/.test(d)) return [30, 0.08, 0.12];
  if (/chapter/.test(d)) return [45, 0.08, 0.15];
  if (/collect|every spot|100 locations|card sets|discover|explore|purchase all/.test(d)) return [8, 0.02, 0.03];
  if (t.tier === 'gold') return [15, 0.03, 0.06];
  if (t.tier === 'silver') return [6, 0.01, 0.03];
  return [12, 0.04, 0.05];
}

const clampPct = (x: number): number => Math.min(99.99, Math.max(0.01, x));
const clamp01 = (x: number): number => Math.min(0.9999, Math.max(0.0001, x));
const logit = (pct: number): number => {
  const p = clamp01(clampPct(pct) / 100);
  return Math.log(p / (1 - p));
};
const sigmoidPct = (l: number): number => 100 / (1 + Math.exp(-Math.max(-30, Math.min(30, l))));
/** x rounded to 4 decimals. */
const round4 = (x: number): number => Math.round(x * 10_000) / 10_000;
const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** Inverse standard normal CDF (Acklam's rational approximation, ~1e-9). */
function normInv(p: number): number {
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239e0];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838e0, -2.549732539343734e0, 4.374664141464968e0, 2.938163982698783e0];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996e0, 3.754408661907416e0];
  const plow = 0.02425;
  const phigh = 1 - plow;
  let q: number;
  let r: number;
  if (p < plow) {
    q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p > phigh) {
    q = Math.sqrt(-2 * Math.log(1 - p));
    return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  q = p - 0.5;
  r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

function zFor(levels: number[]): number[] {
  if (levels.length === LEVELS.length && levels.every((t, j) => t === LEVELS[j])) return Z_STD;
  return levels.map((t) => normInv(Math.min(0.999, Math.max(0.001, t))));
}

/** Last non-null rate of trophy i in the history, or null. */
function lastNonNull(hist: Read[], i: number): number | null {
  for (let j = hist.length - 1; j >= 0; j--) {
    const r = hist[j].rates[i];
    if (r !== null && r !== undefined) return r;
  }
  return null;
}

/** How many distinct rate values trophy i shows in the history. */
function distinctRates(hist: Read[], i: number): number {
  const s = new Set<string>();
  for (const h of hist) {
    const r = h.rates[i];
    if (r !== null && r !== undefined) s.add(r.toFixed(2));
  }
  return s.size;
}

/**
 * Empirical daily hazard for trophy i, from stretches of the history where
 * the tracked population barely moved (so new earners are progression, not
 * dilution): new earners among non-earners per day. Null when no such
 * stretch exists or nothing moved.
 */
function hazardFromHistory(hist: Read[], i: number): number | null {
  const hs: number[] = [];
  for (let j = 1; j < hist.length; j++) {
    const prev = hist[j - 1];
    const cur = hist[j];
    if (cur.players_tracked > prev.players_tracked * 1.05) continue;
    const a = prev.rates[i];
    const b = cur.rates[i];
    if (a === null || b === null) continue;
    const dtD = Math.max(0.001, (Date.parse(cur.at) - Date.parse(prev.at)) / 86_400_000);
    const ePrev = (a / 100) * prev.players_tracked;
    const eCur = (b / 100) * cur.players_tracked;
    const nonEarners = Math.max(1, prev.players_tracked - ePrev);
    const h = (eCur - ePrev) / nonEarners / dtD;
    if (h > 0 && h < 2) hs.push(h);
  }
  return hs.length > 0 ? median(hs) : null;
}

function forecastCase(c: Case): { trophies: Array<{ id: number; q: number[] }> } {
  const levels = c.levels && c.levels.length > 0 ? c.levels : LEVELS;
  const z = zFor(levels);
  const atMs = Date.parse(c.at);
  const targetMs = c.target ? Date.parse(c.target) : atMs + c.horizon_minutes * 60_000;
  const horizonDays = c.horizon_minutes / 1440;
  const hist = c.history.filter((h) => h && typeof h.players_tracked === 'number' && h.players_tracked > 0 && Array.isArray(h.rates));
  const last = hist[hist.length - 1];
  const pLast = last ? last.players_tracked : 1000;
  const tLastMs = last ? Date.parse(last.at) : atMs;
  const tLastH = (tLastMs - RELEASE_MS) / 3_600_000;
  const targetH = (targetMs - RELEASE_MS) / 3_600_000;
  const dtH = Math.max(0, (targetMs - tLastMs) / 3_600_000);
  const dtD = dtH / 24;

  // --- Players-tracked at the target -------------------------------------
  // (a) fitted growth: log players against log(1 + hours since release)
  // (a power law: launch growth is explosive but sub-exponential, and an
  // exponential fit would happily extrapolate it to absurd populations over
  // a 4.5-day horizon). Recency weighted, slope damped.
  let gFit: number | null = null;
  if (hist.length >= 3) {
    const pts = hist.map((h) => ({ x: Math.log(1 + Math.max(0, (Date.parse(h.at) - RELEASE_MS) / 3_600_000)), y: Math.log(h.players_tracked) }));
    const xLast = pts[pts.length - 1].x;
    const span = xLast - pts[0].x;
    if (span > 0.1) {
      let sw = 0;
      let sx = 0;
      let sy = 0;
      let sxx = 0;
      let sxy = 0;
      for (const p of pts) {
        const w = Math.pow(0.5, (xLast - p.x) / Math.log(25));
        sw += w;
        sx += w * p.x;
        sy += w * p.y;
        sxx += w * p.x * p.x;
        sxy += w * p.x * p.y;
      }
      const den = sw * sxx - sx * sx;
      if (den > 1e-9) {
        const slope = (sw * sxy - sx * sy) / den;
        const intercept = (sy - slope * sx) / sw;
        const b = Math.max(0, Math.min(2.5, slope * 0.85));
        const xT = Math.log(1 + Math.max(0, targetH));
        gFit = Math.exp(intercept + b * xT) / pLast;
      }
    }
  }
  const mFit = gFit === null ? 1 : gFit;
  // (b) refresh prior: early after release Exophase refreshes every few
  // hours and each refresh multiplies the tracked population several-fold;
  // the prior decays as the game ages. It fills the gap only when the
  // history shows no refresh at all: once refreshes are in the data, the
  // fitted growth speaks and the prior stays out of its way.
  const tLastDays = Math.max(0, tLastH / 24);
  const jump = 1 + 6.5 * Math.exp(-tLastDays / 2);
  const pRef = 1 - Math.exp(-dtH / 1.2);
  const mRef = 1 + pRef * (jump - 1);
  const hasRefresh = hist.some((h, j) => j > 0 && h.players_tracked > hist[j - 1].players_tracked * 1.15);
  const mult = hasRefresh
    ? Math.min(8, Math.max(1, mFit))
    : Math.min(8, Math.max(1, mFit, mRef));
  const pTarget = pLast * mult;

  // --- Refresh events in the history (players jumped >15% between reads) --
  const refreshQs: number[][] = c.trophies.map(() => []);
  for (let j = 1; j < hist.length; j++) {
    const prev = hist[j - 1];
    const cur = hist[j];
    if (cur.players_tracked <= prev.players_tracked * 1.15) continue;
    const dP = cur.players_tracked - prev.players_tracked;
    for (let i = 0; i < c.trophies.length; i++) {
      const a = prev.rates[i];
      const b = cur.rates[i];
      if (a === null || b === null || dP <= 0) continue;
      const dE = (b * cur.players_tracked - a * prev.players_tracked) / 100;
      refreshQs[i].push(Math.max(0, Math.min(1, dE / dP)));
    }
  }

  // --- Per-trophy trend fit: logit(rate) on ln(1 + hours since release) ---
  const trendLogit: Array<number | null> = c.trophies.map((_, i) => {
    const pts: Array<{ x: number; y: number; tH: number }> = [];
    for (const h of hist) {
      const r = h.rates[i];
      if (r === null || r === undefined) continue;
      pts.push({
        x: Math.log(1 + Math.max(0, (Date.parse(h.at) - RELEASE_MS) / 3_600_000)),
        y: logit(r),
        tH: (Date.parse(h.at) - RELEASE_MS) / 3_600_000,
      });
    }
    const distinct = new Set(pts.map((p) => p.y.toFixed(4))).size;
    if (pts.length < 4 || distinct < 4) return null;
    const tLastPt = pts[pts.length - 1].tH;
    let sw = 0;
    let sx = 0;
    let sy = 0;
    let sxx = 0;
    let sxy = 0;
    for (const p of pts) {
      const w = Math.pow(0.5, (tLastPt - p.tH) / 24);
      sw += w;
      sx += w * p.x;
      sy += w * p.y;
      sxx += w * p.x * p.x;
      sxy += w * p.x * p.y;
    }
    const den = sw * sxx - sx * sx;
    if (den <= 1e-9) return null;
    let slope = (sw * sxy - sx * sy) / den;
    const intercept = (sy - slope * sx) / sw;
    slope *= distinct / (distinct + 4);
    const yT = intercept + slope * Math.log(1 + Math.max(0, targetH));
    const yLastPt = logit(lastNonNull(hist, i) ?? 0);
    // Never let the trend run more than 2 logit units from the last read.
    return Math.max(yLastPt - 2, Math.min(yLastPt + 2, yT));
  });

  const out: Array<{ id: number; q: number[] }> = [];
  for (let i = 0; i < c.trophies.length; i++) {
    const t = c.trophies[i];
    const [prior, qRatio, hazardTable] = TABLE[t.id] ?? fallback(t);
    const rLast = lastNonNull(hist, i);
    const rLastVal = rLast === null ? prior : rLast;
    const eLast = (rLastVal / 100) * pLast;

    // New-joiner earn rate: refresh jumps in the history where they exist,
    // else the researched fraction of the current rate. New joiners have
    // played longer the later they join, so the fraction rises with age.
    const qEmp = refreshQs[i].length > 0 ? median(refreshQs[i]) : null;
    const qAge = 1 + 0.6 * (1 - Math.exp(-Math.max(0, tLastH) / 48));
    const qNew = qEmp === null ? (qRatio * qAge * rLastVal) / 100 : 0.5 * qEmp + 0.5 * ((qRatio * qAge * rLastVal) / 100);

    // Progression hazard for players already tracked: the history's own
    // stable stretches where they exist, else the researched table value.
    // Early after release the hazard is ramped down: nobody has had time
    // to play through to a trophy yet, so the first hours progress slowly
    // no matter the trophy; by day two the hazard runs at full strength.
    const hEmp = hazardFromHistory(hist, i);
    const ramp = 1 - Math.exp(-Math.max(0, tLastH) / 12);
    const hazard = (hEmp === null ? hazardTable : 0.5 * hEmp + 0.5 * hazardTable) * ramp;

    // --- Component 1: the cohort model (earners / players) ---------------
    const eTarget = eLast + (pLast - eLast) * (1 - Math.exp(-hazard * dtD)) + (pTarget - pLast) * qNew;
    const rCohort = clampPct((100 * eTarget) / pTarget);

    // --- Component 2: the logit trend ------------------------------------
    const rTrend = trendLogit[i] === null ? null : clampPct(sigmoidPct(trendLogit[i] as number));

    // --- Component 3: the researched week-one prior, horizon-aware -------
    // s = how far the target sits between the last read and one week after
    // release; the prior only bites as the target approaches the week mark.
    const s = Math.max(0, Math.min(1, (targetH - tLastH) / Math.max(1, WEEK_HOURS - tLastH)));
    const priorLogit = logit(rLastVal) * (1 - 0.7 * s) + logit(prior) * (0.7 * s);
    const rPrior = clampPct(sigmoidPct(priorLogit));

    // --- Blend in logit space, weights by how much the history moved -----
    // The week-one prior is a statement about the end state: its weight
    // grows with the horizon, and nearly vanishes on a 90-minute horizon,
    // where the rate is governed by dilution, not by the week's end state.
    // (Its information is not lost: the cohort model already carries the
    // researched new-joiner rates and hazards.)
    const distinct = distinctRates(hist, i);
    let wC = 0.55;
    let wT = 0;
    let wP = 0.45;
    if (distinct >= 8) {
      wC = 0.5;
      wT = 0.3;
      wP = 0.2;
    } else if (distinct >= 3) {
      wC = 0.45;
      wT = 0.2;
      wP = 0.35;
    }
    const hF = Math.max(0.05, Math.min(1, horizonDays / 3));
    wP *= hF;
    if (rTrend === null) {
      const tot = wC + wP;
      wC /= tot;
      wP /= tot;
      wT = 0;
    } else {
      const tot = wC + wT + wP;
      wC /= tot;
      wT /= tot;
      wP /= tot;
    }
    const comps = [logit(rCohort), rTrend === null ? 0 : logit(rTrend), logit(rPrior)];
    const ws = [wC, wT, wP];
    let medLogit = 0;
    let wSum = 0;
    for (let k = 0; k < 3; k++) {
      if (k === 1 && rTrend === null) continue;
      medLogit += ws[k] * comps[k];
      wSum += ws[k];
    }
    medLogit /= wSum;
    let med = clampPct(sigmoidPct(medLogit));

    // The intro trophy is special: everybody who starts the game earns it
    // within minutes, and the launch night showed the rate pinned at 100%
    // through the first refresh. It only drifts down as the tracked
    // population grows to include buyers who have not played yet, slowly.
    let sigmaCap = 2.2;
    if (rLastVal >= 99.9) {
      // Within a day the rate is pinned at 100%: nobody tracked has failed
      // to start the game yet. It only drifts down as the population grows
      // to include buyers who have not played.
      const drift = horizonDays < 1 ? 0.005 : 0.12 * Math.sqrt(Math.max(0, horizonDays));
      med = Math.max(95, Math.min(99.99, 100 - drift));
      sigmaCap = 0.4;
      medLogit = logit(med);
    }

    // --- Spread: honest about what is unknown ----------------------------
    const lo = Math.min(logit(rCohort), logit(rPrior), rTrend === null ? Infinity : logit(rTrend));
    const hi = Math.max(logit(rCohort), logit(rPrior), rTrend === null ? -Infinity : logit(rTrend));
    const disagree = Math.min(0.8, 0.5 * (hi - lo));
    const base = 0.5 * Math.sqrt(Math.max(0, horizonDays));
    const refreshUnc = Math.min(0.6, 0.3 * (Math.log(mult) / Math.log(2)));
    const flatPenalty = distinct < 3 ? 0.45 : distinct < 8 ? 0.15 : 0;
    const rarePenalty = med < 0.5 ? 0.2 : 0;
    const sigma = Math.min(sigmaCap, Math.max(0.3, 0.8 * (base + refreshUnc + disagree + flatPenalty + rarePenalty)));

    let q = z.map((zv) => round4(clampPct(sigmoidPct(medLogit + zv * sigma))));
    // Rounding must not break the non-decreasing order the scorer requires.
    for (let k = 1; k < q.length; k++) q[k] = Math.max(q[k], q[k - 1]);
    out.push({ id: t.id, q });
  }
  return { trophies: out };
}

mkdirSync(OUTPUT_DIR, { recursive: true });
// Every case file, in name order, so two runs write the same bytes.
const inputs = readdirSync(INPUT_DIR).filter((f) => f.endsWith('.in')).sort();
for (const file of inputs) {
  const id = file.slice(0, -'.in'.length);
  const c = JSON.parse(readFileSync(join(INPUT_DIR, file), 'utf8')) as Case;
  if (!Array.isArray(c.trophies) || !Array.isArray(c.history) || c.history.length === 0) {
    throw new Error(`${file} has no trophies or no history`);
  }
  const result = forecastCase(c);
  if (result.trophies.length !== c.trophies.length) throw new Error(`${file}: wrote ${result.trophies.length} rows for ${c.trophies.length} trophies`);
  const bytes = `${JSON.stringify(result)}\n`;
  if (Buffer.byteLength(bytes, 'utf8') > 65_536) throw new Error(`${file}: output ${Buffer.byteLength(bytes, 'utf8')} bytes exceeds 65,536`);
  writeFileSync(join(OUTPUT_DIR, `${id}.out`), bytes);
}
