import { html } from '../html.mjs';
import { layout, plural, fmt0, fmt1 } from './layout.mjs';
import { counts, sparkRange, speedAt } from '../rank.mjs';
import {
  MARKS, PROVENANCE_TEXT, leaderboardPath, recipePath, recipeBuild,
  statusTag, statusWhy, scoreSource, sectionHead, speedText
} from './common.mjs';

function commandLines(commands) {
  if (!commands) return null;
  return commands.trimEnd().split('\n').map((line) => (
    line.trim().startsWith('#') ? html`<span class="comment">${line}</span>\n` : html`${line}\n`
  ));
}

export function renderRecipe({ ix, url, recipe }) {
  const { config } = ix;
  const model = ix.models.get(recipe.model);
  const build = recipeBuild(ix, recipe);
  const minN = Math.min(...recipe.sparks);
  const own = ix.standingsFor(minN, recipe);
  const me = own.byModel.get(model.id);
  const view = me.view;
  const benches = ix.benchmarkList;
  const reported = benches.filter((b) => view[b.id]).length;
  const countedN = benches.filter((b) => counts(view, b.id)).length;
  const categories = [{ id: 'all', name: 'Overall' }, ...config.categories];

  let match;
  if (reported === 0) match = { badge: 'None yet', text: 'No published scores for this model yet.', solid: false };
  else if (countedN === reported) match = { badge: 'All match', text: `Scores are published for ${plural(reported, 'benchmark')}, and each has one measured on this build, so they all count toward the ranking.`, solid: true };
  else if (countedN === 0) match = { badge: 'None match', text: `Scores are published for ${plural(reported, 'benchmark')}, but none were measured on this build, so none count toward its ranking. They are listed below with what they were measured on.`, solid: false };
  else match = { badge: `${countedN} of ${reported}`, text: `Scores are published for ${plural(reported, 'benchmark')}; ${countedN} of them have one measured on this exact build, and those count. The rest are listed below but not ranked.`, solid: false };

  const siblings = (ix.recipesByModel.get(model.id) ?? []).filter((r) => r !== recipe);

  // Rank at each supported Spark count: scores stay the same, the field changes.
  const rankRows = recipe.sparks.map((n) => {
    const st = ix.standingsFor(n, recipe);
    const cells = categories.map((cat) => {
      const r = st.ranking(cat.id, 'percentile');
      const pos = r.ranked.findIndex((e) => e.model.id === model.id);
      const mine = st.scoreOf(model.id, r.keys);
      return { pos, of: r.ranked.length, mine };
    });
    return { n, cells, speed: speedAt(recipe, n) };
  });

  const benchRows = benches.map((b) => {
    const cell = view[b.id];
    const others = own.entries.filter((e) => e.model.id !== model.id && counts(e.view, b.id));
    const values = others.map((e) => e.view[b.id].chosen.score.value).concat(cell ? [cell.chosen.score.value] : []);
    const top = Math.min(100, Math.ceil(Math.max(10, ...values) / 10) * 10);
    const ticks = others.map((e) => html`<span class="tick" style="left:${((e.view[b.id].chosen.score.value / top) * 100).toFixed(2)}%" title="${e.model.name}: ${fmt1(e.view[b.id].chosen.score.value)}"></span>`);
    let result;
    let marker = '';
    let axisMid;
    if (!cell) {
      result = html`<p>No published score.</p><a class="button secondary" href="${url('contribute/')}">Submit a run</a>`;
      marker = html`<span class="nothing">no published score</span>`;
      axisMid = `${others.length} models that fit count here`;
    } else {
      const { score, status } = cell.chosen;
      const ok = status === 'counts';
      marker = html`<span class="me${ok ? '' : ' hollow'}" style="left:${((score.value / top) * 100).toFixed(2)}%"></span>`;
      const beats = others.filter((e) => e.view[b.id].chosen.score.value < score.value).length;
      axisMid = ok ? `beats ${beats} of ${others.length} that fit` : `${others.length} models that fit count here`;
      const pct = own.pct[b.id][model.id];
      result = html`<span class="num${ok ? '' : ' flagged'}">${fmt1(score.value)}<sup>${MARKS[score.provenance]}</sup></span>
        <span class="badge${ok ? ' solid' : ''}">${ok ? 'Counts' : `Not ranked · ${statusTag(ix, score, status)}`}</span>
        <p>${ok ? `Percentile ${fmt0(pct)} among ${others.length + 1} models that fit ${plural(minN)}` : `${statusWhy(ix, score, status, recipe)[0].toUpperCase()}${statusWhy(ix, score, status, recipe).slice(1)}.`}</p>
        <p class="src">${scoreSource(score)} · <a href="${score.source.url}">source</a></p>`;
    }
    const alsoList = cell ? cell.all.filter((e) => e !== cell.chosen) : [];
    return html`<li>
      <div class="about"><strong>${b.name}</strong><span>${b.description}</span></div>
      <div class="strip" aria-hidden="true"><div class="track">${ticks}${marker}</div><div class="axis"><span>0</span><span>${axisMid}</span><span>${top}</span></div></div>
      <div class="result">${result}</div>
      ${alsoList.length ? html`<ul class="also">${alsoList.map((e) => html`<li>Also ${fmt1(e.score.value)}${MARKS[e.score.provenance]}: ${statusWhy(ix, e.score, e.status, recipe)} · <a href="${e.score.source.url}">${e.score.source.title}</a></li>`)}</ul>` : ''}
    </li>`;
  });

  // Head-to-head against the other models that fit the smallest cluster this recipe runs on.
  const rivals = own.entries.filter((e) => e.model.id !== model.id).map((e) => {
    let w = 0;
    let l = 0;
    let t = 0;
    const marks = benches.map((b) => {
      if (!counts(view, b.id) || !counts(e.view, b.id)) return { t: '', cls: 'none', title: `${b.name}: no score that counts for both` };
      const a = view[b.id].chosen.score.value;
      const z = e.view[b.id].chosen.score.value;
      if (a > z) { w++; return { t: 'W', cls: 'h4', title: `${b.name}: ${fmt1(a)} vs ${fmt1(z)}` }; }
      if (a < z) { l++; return { t: 'L', cls: 'flag', title: `${b.name}: ${fmt1(a)} vs ${fmt1(z)}` }; }
      t++;
      return { t: '=', cls: 'h0', title: `${b.name}: tied at ${fmt1(a)}` };
    });
    return { e, w, l, t, marks, n: w + l + t };
  }).filter((r) => r.n >= 1).sort((a, b) => (b.w - b.l) - (a.w - a.l));

  const missing = benches.filter((b) => !counts(view, b.id)).map((b) => {
    const cell = view[b.id];
    return { b, why: cell ? `only ${statusWhy(ix, cell.chosen.score, cell.chosen.status, recipe)}` : 'not reported for this model on any build' };
  });

  const install = recipe.install;
  const body = html`<div class="wrap">
  <ol class="crumbs"><li><a href="${url(leaderboardPath(minN, 'all', 'percentile'))}">Leaderboard</a></li><li aria-hidden="true">/</li><li>${model.name}</li><li aria-hidden="true">/</li><li aria-current="page">${build.label}</li></ol>
  <section class="recipe-head">
    <div>
      <p class="kicker">Spark recipe · by ${recipe.author}</p>
      <h1><span class="model">${model.name}</span><span class="build">${build.label} on ${sparkRange(recipe)}</span></h1>
      <ul class="facts">
        <li>${model.developer}</li>
        ${model.params_total_b ? html`<li>${model.params_total_b}B total${model.params_active_b ? ` · ${model.params_active_b}B active` : ''}</li>` : ''}
        ${model.license ? html`<li>${model.license}</li>` : ''}
        ${model.released ? html`<li>Released ${model.released}</li>` : ''}
        <li>${countedN} of ${benches.length} scores count</li>
      </ul>
    </div>
    <a class="install" href="${install.url}"><strong>${install.label ?? 'Install'} →</strong><span>${install.url.replace('https://', '')}</span></a>
  </section>

  <section class="card" aria-labelledby="recipe-title">
    <header><h2 id="recipe-title">01 · The recipe</h2></header>
    <div class="card-grid">
      <dl class="props">
        <dt>Recipe</dt><dd><a href="${recipe.url}">${recipe.title}</a>${recipe.version ? ` · ${recipe.version}` : ''}${recipe.updated ? ` · ${recipe.updated}` : ''}</dd>
        <dt>Build</dt><dd>${build.url ? html`<a href="${build.url}">${build.label}</a>` : build.label} · ${build.format}${build.size_gb ? ` · ${fmt1(build.size_gb)} GB` : ''}${build.by ? ` · by ${build.by}` : ''}</dd>
        <dt>Runs on</dt><dd>${sparkRange(recipe)}${recipe.experimental?.length ? `; ${recipe.experimental.join(' and ')} experimental` : ''}</dd>
        <dt>Engine</dt><dd>${recipe.engine}</dd>
        <dt>Model</dt><dd>${model.url ? html`<a href="${model.url}">${model.name}</a>` : model.name} by ${model.developer}</dd>
        ${recipe.notes ? html`<dt>Notes</dt><dd>${recipe.notes}</dd>` : ''}
        <dt>Ranked scores</dt><dd><span class="badge${match.solid ? ' solid' : ''}">${match.badge}</span> ${match.text}</dd>
      </dl>
      <div>
        ${recipe.commands ? html`<pre class="terminal"><code>${commandLines(recipe.commands)}</code></pre>` : html`<p class="empty" style="margin:0">See the recipe for install steps.</p>`}
      </div>
    </div>
    <div class="speeds">
      <h3>Speed by Spark count</h3>
      <div class="speed-cards">
        ${recipe.sparks.map((n) => {
          const s = speedAt(recipe, n);
          const exp = recipe.experimental?.includes(n);
          return html`<div class="speed-card"><header><strong>${plural(n)}</strong><span class="label">${exp ? 'experimental' : ''}</span></header>
            <dl><dt>Decode</dt><dd>${s?.decode_tps ? `${fmt1(s.decode_tps)} t/s` : '—'}</dd><dt>Prefill</dt><dd>${s?.prefill_tps ? `${fmt0(s.prefill_tps)} t/s` : '—'}</dd><dt>First token</dt><dd>${s?.ttft_ms ? `${fmt0(s.ttft_ms)} ms` : '—'}</dd></dl>
            ${s ? html`<p class="small muted" style="margin:6px 0 0">${[s.workload, s.prefill_prompt ? `prefill on ${s.prefill_prompt}` : null].filter(Boolean).join('; ')} · <a href="${s.source}">source</a></p>` : ''}
          </div>`;
        })}
      </div>
    </div>
  </section>

  ${siblings.length ? html`<section class="section" style="padding-top:28px" aria-labelledby="siblings-title">
    <h2 id="siblings-title" class="label" style="margin:0 0 12px;font-size:13px">Other recipes for ${model.name}</h2>
    <ul class="siblings">${siblings.map((r) => {
      const sb = recipeBuild(ix, r);
      const sView = ix.standingsFor(Math.min(...r.sparks), r).byModel.get(model.id).view;
      const c = benches.filter((b) => counts(sView, b.id)).length;
      const fastest = Math.max(0, ...(r.speeds ?? []).map((s) => s.decode_tps ?? 0));
      return html`<li><a class="title" href="${url(recipePath(r))}">${r.title}</a><span>${sb.label} · by ${r.author}</span><span>${sparkRange(r)}${sb.size_gb ? ` · ${fmt0(sb.size_gb)} GB` : ''}</span><span>${c} of ${benches.length} scores count · ${fastest ? `up to ${fmt1(fastest)} t/s` : 'no speed data'}</span></li>`;
    })}</ul>
  </section>` : ''}

  <section class="section" style="padding-top:28px" aria-labelledby="ranks-title">
    <h2 id="ranks-title" class="label" style="margin:0 0 12px;font-size:13px">Rank by Spark count</h2>
    <div class="table-wrap" style="border:0"><table class="ranks">
      <thead><tr><th scope="col">Sparks</th>${categories.map((c) => html`<th scope="col">${c.name}</th>`)}<th scope="col">Speed</th></tr></thead>
      <tbody>${rankRows.map((row) => html`<tr><th scope="row"><a href="${url(leaderboardPath(row.n, 'all', 'percentile'))}">${plural(row.n)}</a></th>${row.cells.map((c) => html`<td>${c.pos >= 0 ? html`<b>#${c.pos + 1}</b><span>of ${c.of} ranked · index ${fmt0(c.mine.value)}</span>` : html`<b>–</b><span>not ranked: ${c.mine.have} of ${c.mine.need} needed</span>`}</td>`)}<td class="speed">${speedText(row.speed)}</td></tr>`)}</tbody>
    </table></div>
    <p class="footnote">Scores don’t change with the number of Sparks; the field does. Each row ranks this recipe against every model that fits that many Sparks, on its best recipe there.</p>
  </section>

  <section class="section">
    ${sectionHead('02', 'Benchmark by benchmark', `Compared with the ${own.entries.length - 1} other models that fit ${plural(minN)}`)}
    <ol class="bench-rows">${benchRows}</ol>
  </section>

  <section class="section">
    ${sectionHead('03', `Head-to-head on ${plural(minN)}`, 'Only scores that count for both are compared')}
    ${rivals.length ? html`<div class="table-wrap" style="margin-top:20px"><table class="board" style="min-width:760px">
      <thead><tr><th scope="col">Against</th><th scope="col">W–L</th>${benches.map((b) => html`<th class="bench" scope="col" title="${b.name}">${b.short}</th>`)}</tr></thead>
      <tbody>${rivals.map((r) => html`<tr><td class="model"><a href="${url(recipePath(r.e.recipe))}">${r.e.model.name}</a><div>${recipeBuild(ix, r.e.recipe).label} · ${sparkRange(r.e.recipe)}</div></td><td class="mono">${r.w}–${r.l}${r.t ? `–${r.t}` : ''}</td>${r.marks.map((m) => html`<td class="score"><span class="cell ${m.cls}" style="align-items:center" title="${m.title}">${m.t}</span></td>`)}</tr>`)}</tbody>
    </table></div>` : html`<p class="empty">${countedN === 0 ? 'None of this recipe’s scores count yet, so there is nothing to compare. A run of this recipe on any of the benchmarks above would change that.' : 'No other model that fits shares a counted benchmark with this recipe yet.'}</p>`}
  </section>

  ${missing.length ? html`<section class="section">
    ${sectionHead('04', 'Runs that would complete this page')}
    <ul class="list" style="margin-top:16px">${missing.map(({ b, why }) => html`<li><span><b>${b.name}</b> · ${why}.</span><a class="button secondary" href="${url('contribute/')}">Submit a score</a></li>`)}</ul>
  </section>` : ''}
</div>`;

  return layout({
    config,
    url,
    title: `${model.name} · ${build.label}`,
    description: `${model.name} ${build.label} on ${sparkRange(recipe)}: install, speed and benchmark scores.`,
    current: 'leaderboard',
    body
  });
}

export { PROVENANCE_TEXT };
