import { html } from '../html.mjs';
import { layout, plural, fmt0, fmt1 } from './layout.mjs';
import { counts } from '../rank.mjs';
import {
  MARKS, PROVENANCE_TEXT, leaderboardPath, recipePath, recipeLines, heatClass,
  statusTag, statusWhy, scoreSource, sectionHead
} from './common.mjs';

const METHODS = [
  { id: 'percentile', label: 'Mean percentile' },
  { id: 'h2h', label: 'Head-to-head wins' }
];

function scoreCell(ix, entry, benchmarkId, st, best) {
  const cell = entry.view[benchmarkId];
  const benchmark = ix.benchmarks.get(benchmarkId);
  if (!cell) {
    return html`<td class="score" data-v=""><span class="cell none" title="${benchmark.name}: not reported">—</span></td>`;
  }
  const { score, status } = cell.chosen;
  const others = cell.all.filter((e) => e !== cell.chosen)
    .map((e) => `${fmt1(e.score.value)}${MARKS[e.score.provenance]} (${statusWhy(ix, e.score, e.status, entry.recipe)})`);
  const extra = others.length ? ` Also: ${others.join('; ')}.` : '';
  if (status === 'counts') {
    const pct = st.pct[benchmarkId][entry.model.id];
    const spark = cell.all.find((e) => e !== cell.chosen && e.score.provenance === 'spark');
    const title = `${benchmark.name}: ${fmt1(score.value)} · ${scoreSource(score)}. Counts.${extra}`;
    return html`<td class="score" data-v="${score.value}"><span class="cell ${heatClass(pct)}${score.value === best ? ' best' : ''}" title="${title}">${fmt1(score.value)}<sup>${MARKS[score.provenance]}</sup>${spark ? html`<small>◆ ${fmt1(spark.score.value)}</small>` : ''}</span></td>`;
  }
  const title = `${benchmark.name}: ${fmt1(score.value)} · ${scoreSource(score)}. Not ranked: ${statusWhy(ix, score, status, entry.recipe)}.${extra}`;
  return html`<td class="score" data-v=""><span class="cell flag" title="${title}">${fmt1(score.value)}<sup>${MARKS[score.provenance]}</sup><small>${statusTag(ix, score, status)}</small></span></td>`;
}

function boardRow(ix, url, st, entry, rank, keys, best, n) {
  const lines = recipeLines(ix, entry.recipe, n);
  // An index from too few benchmarks is not shown: one lucky score would read as 100.
  const value = entry.score.ranked ? entry.score.value : null;
  const countedN = keys.filter((k) => counts(entry.view, k)).length;
  const flaggedN = keys.filter((k) => entry.view[k] && !counts(entry.view, k)).length;
  const run = [lines.run, entry.others.length ? `+${entry.others.length} more` : null].filter(Boolean).join(' · ');
  const othersTitle = entry.others.length
    ? `Other recipes that fit: ${entry.others.map((r) => `${ix.models.get(r.model).builds[r.build].label} (${r.sparks.join('/')} Sparks)`).join('; ')}`
    : '';
  return html`<tr class="entry${entry.score.ranked ? '' : ' unranked'}">
  <td class="rank">${rank ?? '–'}</td>
  <td class="model"><a href="${url(recipePath(entry.recipe))}">${entry.model.name}</a><div>${entry.model.developer}${entry.model.params_total_b ? ` · ${entry.model.params_total_b}B` : ''}${entry.model.params_active_b ? ` · ${entry.model.params_active_b}B active` : ''}</div></td>
  <td class="recipe" title="${othersTitle}"><b>${lines.name}</b><span>${lines.by}</span><span>${lines.range}</span>${run ? html`<span>${run}</span>` : ''}</td>
  <td class="index" data-v="${value ?? ''}"><div class="indexbar"><b>${value === null ? '—' : fmt0(value)}</b><i><em style="width:${value === null ? 0 : value.toFixed(1)}%"></em></i></div></td>
  <td class="coverage" aria-label="${countedN} of ${keys.length} benchmarks count${flaggedN ? `; ${flaggedN} more shown but not ranked` : ''}"><div class="dots" aria-hidden="true">${keys.map((k) => html`<i class="${counts(entry.view, k) ? 'on' : entry.view[k] ? 'flag' : ''}"></i>`)}</div>${countedN}/${keys.length}${flaggedN ? ` · +${flaggedN}` : ''}</td>
  ${keys.map((k) => scoreCell(ix, entry, k, st, best[k]))}
</tr>`;
}

export function renderLeaderboard({ ix, url, n, category, method }) {
  const { config } = ix;
  const st = ix.standingsFor(n);
  const { keys, need, ranked, unranked } = st.ranking(category, method);
  const benches = keys.map((k) => ix.benchmarks.get(k));
  const best = {};
  for (const k of keys) {
    const vals = st.entries.filter((e) => counts(e.view, k)).map((e) => e.view[k].chosen.score.value);
    best[k] = vals.length ? Math.max(...vals) : null;
  }
  const categories = [{ id: 'all', name: 'All' }, ...config.categories];
  const keysOf = (cat) => ix.benchmarkList.filter((b) => cat === 'all' || b.categories.includes(cat));
  const total = st.entries.length * keys.length;
  const countedCells = st.entries.reduce((sum, e) => sum + keys.filter((k) => counts(e.view, k)).length, 0);
  const unit = method === 'percentile' ? 'index' : '% of match-ups won';

  const picker = html`<section class="wrap" aria-label="Your cluster">
  <div class="picker-head"><h2>How many Sparks do you have?</h2><p>More Sparks can unlock other recipes, and run the same recipe faster</p></div>
  <nav class="spark-picker" aria-label="Number of DGX Sparks">
    ${config.spark_counts.map((c) => {
      const fit = ix.standingsFor(c).entries.length;
      return html`<a href="${url(leaderboardPath(c, category, method))}"${c === n ? html` aria-current="page"` : ''}><strong>${plural(c)}</strong><span>${fmt0(c * 128)} GB · ${fit} model${fit === 1 ? '' : 's'}</span></a>`;
    })}
  </nav>
</section>`;

  const picks = html`<section class="wrap section" aria-labelledby="picks-title" style="padding-top:40px">
  <h2 id="picks-title" style="margin:0 0 14px;font-size:22px">Best picks for ${plural(n)}</h2>
  <div class="picks">
    ${categories.map((cat) => {
      const r = st.ranking(cat.id, method);
      const top = r.ranked[0];
      const next = r.ranked[1];
      if (!top) {
        return html`<article class="pick"><span class="label">${cat.id === 'all' ? 'Overall' : cat.name}</span><p style="color:var(--ink-2);font-size:15px">No recipe that fits has enough ${cat.id === 'all' ? '' : `${cat.name.toLowerCase()} `}scores that count yet.</p></article>`;
      }
      const lines = recipeLines(ix, top.recipe, n);
      return html`<article class="pick">
        <span class="label">${cat.id === 'all' ? 'Overall' : cat.name}</span>
        <h3><a href="${url(recipePath(top.recipe))}">${top.model.name}</a></h3>
        <p class="value"><strong>${fmt0(top.score.value)}</strong><span>${unit} · ${top.score.have} of ${r.keys.length} count</span></p>
        <p>${lines.name} · ${lines.range}${lines.run ? ` · ${lines.run}` : ''}</p>
        <p>${next ? `Next: ${next.model.name} (${fmt0(next.score.value)})` : 'No runner-up with enough scores'}</p>
      </article>`;
    })}
  </div>
</section>`;

  const rows = [];
  ranked.forEach((e, i) => rows.push(boardRow(ix, url, st, e, i + 1, keys, best, n)));
  if (unranked.length) {
    rows.push(html`<tr class="divider"><td colspan="${5 + keys.length}">Not ranked: fewer than ${need} of ${keys.length} benchmarks count for this recipe</td></tr>`);
    unranked.forEach((e) => rows.push(boardRow(ix, url, st, e, null, keys, best, n)));
  }

  const board = html`<section class="wrap section" id="leaderboard">
  ${sectionHead('01', 'Leaderboard', `${st.entries.length} models · ${countedCells} of ${total} scores count for these recipes`)}
  <div class="controls">
    <nav class="chip-group" aria-label="Benchmark category"><span class="label">Category</span>
      ${categories.map((cat) => html`<a class="chip" href="${url(leaderboardPath(n, cat.id, method))}"${cat.id === category ? html` aria-current="page"` : ''}>${cat.name}<small>${keysOf(cat.id).length}</small></a>`)}
    </nav>
    <nav class="chip-group" aria-label="Ranking method"><span class="label">Rank by</span>
      ${METHODS.map((m) => html`<a class="chip" href="${url(leaderboardPath(n, category, m.id))}"${m.id === method ? html` aria-current="page"` : ''}>${m.label}</a>`)}
    </nav>
  </div>
  <div class="legend">
    <div><span class="label">Counts</span><span><span class="swatches" aria-hidden="true"><i style="background:var(--heat-0)"></i><i style="background:var(--heat-1)"></i><i style="background:var(--heat-2)"></i><i style="background:var(--heat-3)"></i><i style="background:var(--heat-4)"></i></span> percentile among models that fit</span><span>no mark: developer-reported · ● independent · ○ another lab’s table · ◆ run on a Spark</span></div>
    <div><span class="label">Shown, not ranked</span><span><span class="tag-sample">@BF16</span> other build</span><span><span class="tag-sample">name</span> other model version</span><span><span class="tag-sample">v2.0</span> other test version</span><span><span class="tag-sample">subset</span> partial test</span><span><span class="hatch-sample"></span> not reported</span></div>
  </div>
  <div class="table-wrap">
    <table class="board" data-sortable>
      <thead><tr>
        <th class="rank" scope="col">#</th>
        <th scope="col">Model</th>
        <th scope="col">Recipe<br><span class="sub">for ${plural(n)}</span></th>
        <th scope="col" aria-sort="descending" data-sort-default><button type="button" data-sort="index"><span>${method === 'percentile' ? 'Index' : 'Win rate'}</span><span class="sub">${method === 'percentile' ? 'mean percentile' : '% match-ups'}</span></button></th>
        <th scope="col">Counted</th>
        ${benches.map((b) => {
          const have = st.entries.filter((e) => counts(e.view, b.id)).length;
          return html`<th class="bench" scope="col"><button type="button" data-sort="bench" title="${b.name} ${b.version}"><span>${b.short}</span><span class="sub">${have}/${st.entries.length}</span></button></th>`;
        })}
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </div>
  <p class="footnote">${method === 'percentile'
    ? 'Index: the mean of a recipe’s percentiles, among the models that fit, across the benchmarks that count for it.'
    : 'Win rate: the share of head-to-head match-ups won against the other models that fit, on benchmarks that count for both.'} A recipe needs ${need} of ${keys.length} to be ranked. Dashed cells were measured on a different build, model version, test version or a subset, and are left out. Hover a score for its source; click a column to sort by it.</p>
</section>`;

  // Coverage and wanted runs, across all benchmarks.
  const allKeys = ix.benchmarkList.map((b) => b.id);
  const allTotal = st.entries.length * allKeys.length;
  const allCounted = st.entries.reduce((sum, e) => sum + allKeys.filter((k) => counts(e.view, k)).length, 0);
  const allFlagged = st.entries.reduce((sum, e) => sum + allKeys.filter((k) => e.view[k] && !counts(e.view, k)).length, 0);
  const overall = st.ranking('all', 'percentile');
  const wantedFrom = [...overall.ranked, ...overall.unranked];
  const wanted = [];
  for (const e of wantedFrom) {
    for (const b of ix.benchmarkList) {
      if (wanted.length >= 8 || counts(e.view, b.id)) continue;
      const cell = e.view[b.id];
      const why = cell ? `Only ${statusWhy(ix, cell.chosen.score, cell.chosen.status, e.recipe)}` : 'Not reported for this model';
      wanted.push({ e, b, why });
    }
  }

  const coverage = html`<div class="wrap section two-col" id="coverage">
  <section>
    ${sectionHead('02', 'How complete the grid is')}
    <p class="section-intro">Of ${allTotal} possible scores for the ${st.entries.length} models that fit ${plural(n)}, ${allCounted} were measured on the recipe’s exact model and build. Another ${allFlagged} exist but were measured on something else.</p>
    <ol class="bars">
      ${ix.benchmarkList.map((b) => {
        const c = st.entries.filter((e) => counts(e.view, b.id)).length;
        const f = st.entries.filter((e) => e.view[b.id] && !counts(e.view, b.id)).length;
        const tot = st.entries.length || 1;
        return html`<li><span>${b.name}</span><span class="bar"><i style="width:${((c / tot) * 100).toFixed(1)}%"></i><i class="flag" style="width:${((f / tot) * 100).toFixed(1)}%"></i></span><span>${c}${f ? ` +${f}` : ''} / ${st.entries.length}</span></li>`;
      })}
    </ol>
  </section>
  <section>
    ${sectionHead('03', 'Scores we need next')}
    <p class="section-intro">Benchmarks that don’t yet count for the top recipes. A run on the recipe’s exact build, on a Spark, is the most useful contribution.</p>
    <ul class="list">
      ${wanted.map(({ e, b, why }) => html`<li><span><a href="${url(recipePath(e.recipe))}">${e.model.name}</a> × ${b.name}<span class="why">${why}</span></span><a class="button secondary" href="${url('contribute/')}">Submit a score</a></li>`)}
    </ul>
  </section>
</div>`;

  const body = html`<section class="wrap hero">
  <p class="kicker">${config.tagline}</p>
  <div class="hero-grid">
    <h1>The best open models that fit on your Sparks</h1>
    <p class="lede">Ranked on ${ix.benchmarkList.map((b) => b.name).join(', ')}. Each model is shown with the recipe your cluster can run, and a score only counts if it was measured on that exact model version and build.</p>
  </div>
</section>
${picker}
${picks}
${board}
${coverage}`;

  return layout({
    config,
    url,
    title: `${plural(n)} · ${categories.find((c) => c.id === category).name}`,
    description: `Open-weight model recipes ranked for ${plural(n)}.`,
    current: 'leaderboard',
    body
  });
}

export { PROVENANCE_TEXT };
