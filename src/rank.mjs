// Ranking logic. Everything here is a pure function of the loaded data, so
// the build can call it for every page and the tests can call it directly.
//
// The rules, in plain words:
//   - A score counts for a recipe only if it was measured on the recipe's
//     exact model and build, on the benchmark version the site uses, on the
//     full test set.
//   - Scores that fail any of those are shown, labelled, and left out.
//   - Running a recipe on more Sparks changes its speed, never its scores.
//   - For a cluster of n Sparks, each model is represented by one recipe:
//     the one whose counted scores rank best; ties go to more bits per
//     weight, then to using more of the Sparks, then to faster decode.

export const STATUS_ORDER = { counts: 0, sample: 1, 'test-version': 2, build: 3, 'model-version': 4 };
const PROVENANCE_ORDER = { spark: 0, independent: 1, lab: 2, 'other-lab': 3 };

function dateNumber(date) {
  if (!date) return 0;
  const [y, m = '00', d = '00'] = String(date).split('-');
  return Number(y + m + d);
}

// Compare two arrays element by element (numbers or strings).
function compareKeys(a, b) {
  for (let i = 0; i < a.length; i++) {
    if (a[i] < b[i]) return -1;
    if (a[i] > b[i]) return 1;
  }
  return 0;
}

export function buildIndex(data) {
  const models = new Map(data.models.map((m) => [m.id, m]));
  const benchmarks = new Map(data.benchmarks.map((b) => [b.id, b]));
  const recipesByModel = new Map();
  for (const r of data.recipes) {
    if (!recipesByModel.has(r.model)) recipesByModel.set(r.model, []);
    recipesByModel.get(r.model).push(r);
  }
  const scoresByKey = new Map();
  for (const s of data.scores) {
    const key = `${s.model}|${s.benchmark}`;
    if (!scoresByKey.has(key)) scoresByKey.set(key, []);
    scoresByKey.get(key).push(s);
  }
  return {
    config: data.config,
    models,
    benchmarks,
    benchmarkList: data.benchmarks,
    recipes: data.recipes,
    recipesByModel,
    scoresFor: (modelId, benchmarkId) => scoresByKey.get(`${modelId}|${benchmarkId}`) ?? []
  };
}

export function scoreStatus(score, recipe, benchmark) {
  if (score.model !== recipe.model) return 'model-version';
  if ((score.build ?? 'release') !== recipe.build) return 'build';
  if (score.benchmark_version !== benchmark.version) return 'test-version';
  if (score.subset) return 'sample';
  return 'counts';
}

// Every score shown for one recipe on one benchmark, best first: the model's
// own scores and those of related versions, each with its status. The first
// one is the score used: counted before flagged, then the most independent
// source (a Spark run, then an independent leaderboard, then the developer),
// then the highest value (a model's best published setting), then the newest.
export function cellFor(ix, recipe, benchmarkId) {
  const model = ix.models.get(recipe.model);
  const benchmark = ix.benchmarks.get(benchmarkId);
  const related = (model.related ?? []).flatMap((id) => ix.scoresFor(id, benchmarkId));
  const all = ix.scoresFor(recipe.model, benchmarkId)
    .concat(related)
    .map((score) => ({ score, status: scoreStatus(score, recipe, benchmark) }));
  if (all.length === 0) return null;
  const key = (e) => [STATUS_ORDER[e.status], PROVENANCE_ORDER[e.score.provenance], -e.score.value, -dateNumber(e.score.source.date)];
  all.sort((a, b) => compareKeys(key(a), key(b)));
  return { chosen: all[0], all };
}

export function viewFor(ix, recipe) {
  const view = {};
  for (const b of ix.benchmarkList) view[b.id] = cellFor(ix, recipe, b.id);
  return view;
}

export function counts(view, benchmarkId) {
  return view[benchmarkId]?.chosen.status === 'counts';
}

export function minSparks(recipe) {
  return Math.min(...recipe.sparks);
}

// How many of n Sparks the recipe would use: its largest supported count <= n.
export function usedSparks(recipe, n) {
  const fitting = recipe.sparks.filter((c) => c <= n);
  return fitting.length ? Math.max(...fitting) : null;
}

export function speedAt(recipe, n) {
  return (recipe.speeds ?? []).find((s) => s.sparks === n) ?? null;
}

export function sparkRange(recipe) {
  const ns = [...recipe.sparks].sort((a, b) => a - b);
  const plural = (k) => `${k} Spark${k === 1 ? '' : 's'}`;
  if (ns.length === 1) return plural(ns[0]);
  const contiguous = ns[ns.length - 1] - ns[0] === ns.length - 1;
  return contiguous ? `${ns[0]}–${ns[ns.length - 1]} Sparks` : `${ns.join(' or ')} Sparks`;
}

// Percentile of `value` among `others` (other models' counted values).
function percentileAgainst(value, others) {
  if (others.length === 0) return 50;
  const lower = others.filter((v) => v < value).length;
  const equal = others.filter((v) => v === value).length;
  return ((lower + equal / 2) / others.length) * 100;
}

// Choose one recipe per model for a cluster of n Sparks. `forced` pins one
// recipe (used on recipe pages so the page's own recipe is always the one
// compared, even if the model has a better-ranked recipe).
export function chooseRecipes(ix, n, forced = null) {
  const candidates = [];
  for (const [modelId, recipes] of ix.recipesByModel) {
    let list = recipes.filter((r) => minSparks(r) <= n);
    if (forced && forced.model === modelId) list = [forced];
    if (list.length === 0) continue;
    candidates.push({
      modelId,
      options: list.map((recipe) => ({ recipe, view: viewFor(ix, recipe) }))
    });
  }

  const hasCounts = (o) => ix.benchmarkList.some((b) => counts(o.view, b.id));
  const tieKey = (o) => {
    const model = ix.models.get(o.recipe.model);
    const bits = model.builds[o.recipe.build]?.bits ?? 0;
    const used = usedSparks(o.recipe, n);
    const decode = speedAt(o.recipe, used)?.decode_tps ?? 0;
    return [hasCounts(o) ? 0 : 1, -bits, -used, -decode, o.recipe.id];
  };
  const byTie = (a, b) => compareKeys(tieKey(a), tieKey(b));

  const first = new Map(candidates.map((c) => [c.modelId, [...c.options].sort(byTie)[0]]));

  // Where a model has several recipes with counted scores, pick the one whose
  // scores rank best against the other models' first choices.
  const fieldValues = (benchmarkId, excludeModel) => [...first.entries()]
    .filter(([id, o]) => id !== excludeModel && counts(o.view, benchmarkId))
    .map(([, o]) => o.view[benchmarkId].chosen.score.value);
  const strength = (modelId, view) => {
    const ids = ix.benchmarkList.map((b) => b.id).filter((id) => counts(view, id));
    if (ids.length === 0) return -1;
    return ids.reduce((sum, id) => sum + percentileAgainst(view[id].chosen.score.value, fieldValues(id, modelId)), 0) / ids.length;
  };

  const chosen = [];
  for (const c of candidates) {
    const withCounts = c.options.filter(hasCounts);
    let pick = first.get(c.modelId);
    if (withCounts.length > 1) {
      pick = [...withCounts].sort((a, b) => (strength(c.modelId, b.view) - strength(c.modelId, a.view)) || byTie(a, b))[0];
    }
    chosen.push({
      model: ix.models.get(c.modelId),
      recipe: pick.recipe,
      view: pick.view,
      others: c.options.filter((o) => o !== pick).map((o) => o.recipe)
    });
  }
  return chosen;
}

// Scores, percentiles and rankings for a cluster of n Sparks.
export function standings(ix, n, { forced = null, minCoverage = ix.config.ranking.min_coverage } = {}) {
  const entries = chooseRecipes(ix, n, forced);
  const byModel = new Map(entries.map((e) => [e.model.id, e]));

  // Percentile of each counted score among the counted scores of every
  // model that fits, on that benchmark.
  const pct = {};
  for (const b of ix.benchmarkList) {
    const have = entries.filter((e) => counts(e.view, b.id));
    pct[b.id] = {};
    for (const e of have) {
      const v = e.view[b.id].chosen.score.value;
      const lower = have.filter((o) => o.view[b.id].chosen.score.value < v).length;
      const equal = have.filter((o) => o.view[b.id].chosen.score.value === v).length;
      pct[b.id][e.model.id] = have.length > 1 ? ((lower + (equal - 1) / 2) / (have.length - 1)) * 100 : 50;
    }
  }

  const keysFor = (category) => ix.benchmarkList
    .filter((b) => category === 'all' || b.categories.includes(category))
    .map((b) => b.id);

  const need = (keys) => Math.max(1, Math.ceil(keys.length * minCoverage));

  function scoreOf(modelId, keys, method = 'percentile') {
    const e = byModel.get(modelId);
    const have = keys.filter((k) => counts(e.view, k));
    let value = null;
    let matchups = 0;
    if (method === 'percentile') {
      if (have.length) value = have.reduce((sum, k) => sum + pct[k][modelId], 0) / have.length;
    } else {
      let wins = 0;
      for (const other of entries) {
        if (other.model.id === modelId) continue;
        for (const k of have) {
          if (!counts(other.view, k)) continue;
          matchups++;
          const a = e.view[k].chosen.score.value;
          const z = other.view[k].chosen.score.value;
          wins += a > z ? 1 : a === z ? 0.5 : 0;
        }
      }
      value = matchups ? (wins / matchups) * 100 : null;
    }
    return { have: have.length, need: need(keys), value, matchups, ranked: have.length >= need(keys) && value !== null };
  }

  function ranking(category, method = 'percentile') {
    const keys = keysFor(category);
    const scored = entries.map((e) => ({ ...e, score: scoreOf(e.model.id, keys, method) }));
    const byValue = (a, b) => (b.score.value ?? -1) - (a.score.value ?? -1) || a.model.name.localeCompare(b.model.name);
    const ranked = scored.filter((e) => e.score.ranked).sort(byValue);
    const unranked = scored.filter((e) => !e.score.ranked).sort((a, b) => (b.score.have - a.score.have) || byValue(a, b));
    return { keys, need: need(keys), ranked, unranked };
  }

  return { n, entries, byModel, pct, keysFor, scoreOf, ranking };
}
