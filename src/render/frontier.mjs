// Best picks for n Sparks, driven by the speed and score frontier: every
// ranked recipe that fits is plotted at its measured decode speed against its
// score, and the picks are the recipes on the frontier, the ones nothing that
// fits beats on both. Each pick is the most capable recipe at its speed.

import { html } from '../html.mjs';
import { plural, fmt0, fmt1 } from './layout.mjs';
import { minSparks, usedSparks, speedAt, paretoFrontier } from '../rank.mjs';
import { leaderboardPath, recipePath, recipeBuild } from './common.mjs';

// Two fixed sizes, so text stays at its real size: a wide chart, and a
// narrow one swapped in on phones by CSS.
const SIZES = {
  wide: { W: 860, H: 420, M: { l: 56, r: 24, t: 20, b: 56 }, ticks: 5 },
  narrow: { W: 360, H: 340, M: { l: 40, r: 14, t: 16, b: 52 }, ticks: 3 }
};
const NAME_PX = 6.6; // approximate width per character, 12px sans
const MAX_CARDS = 4;

function niceStep(raw) {
  const p = 10 ** Math.floor(Math.log10(raw));
  return [1, 2, 2.5, 5, 10].map((m) => m * p).find((s) => s >= raw);
}

// The ways a recipe can run on n Sparks: one copy on the most Sparks it
// supports, and, where its smallest setup fits more than once, as many
// independent copies of that as fit, their decode speeds summed. Each way has
// its copies, the Sparks each copy uses, and its speed, if one is measured.
export function deployments(recipe, n) {
  const used = usedSparks(recipe, n);
  if (used === null) return [];
  const per = minSparks(recipe);
  const copies = Math.floor(n / per);
  const one = { copies: 1, per: used, used, tps: speedAt(recipe, used)?.decode_tps };
  if (copies < 2) return [one];
  const tps = speedAt(recipe, per)?.decode_tps;
  const many = { copies, per, used: copies * per, tps: tps === undefined ? undefined : tps * copies };
  // One copy on the same Sparks as each of the copies is the same model at
  // a fraction of the speed, so it's left off.
  return used === per ? [many] : [one, many];
}

// Every recipe that fits, scored as if it were the one representing its model
// (so a model's other recipes can sit on the frontier too), at each way it
// can run.
export function frontierPoints(ix, n, category, method) {
  const fit = ix.recipes.filter((r) => minSparks(r) <= n);
  const plotted = [];
  const noSpeed = [];
  let withSpeed = 0;
  for (const recipe of fit) {
    const ways = deployments(recipe, n).filter((d) => d.tps !== undefined);
    if (ways.length) withSpeed++;
    const entry = ix.standingsFor(n, recipe).ranking(category, method).ranked.find((e) => e.recipe === recipe);
    if (!entry) continue;
    if (!ways.length) noSpeed.push(entry);
    for (const d of ways) plotted.push({ x: d.tps, y: entry.score.value, m: entry.score.margin ?? 0, entry, used: d.used, per: d.per, copies: d.copies });
  }
  return { fit: fit.length, withSpeed, plotted, noSpeed, frontier: paretoFrontier(plotted) };
}

// The name a point goes by: its model, and how many copies of it run.
const copiesName = (p, name = p.entry.model.name) => (p.copies > 1 ? `${p.copies}× ${name}` : name);
// Points are coloured by the Sparks each copy uses.
const sparkClass = (p) => `s${Math.min(p.per, 4)}`;
const howRun = (p) => (p.copies > 1 ? `${p.copies} copies, ${plural(p.per)} each` : `runs on ${plural(p.used)}`);

// A name callout for every point, frontier names first. Each tries eight
// spots around its point and takes the first inside the plot that clears
// every point, the frontier line and every callout placed so far. Frontier
// callouts are always drawn; another with no clear spot is left off (its
// point still has a hover title).
function placeCallouts(ix, points, onFrontier, line, sx, sy, W, H, M, compact) {
  const R = 8;
  const boxes = points.map((p) => ({ x0: sx(p.x) - R, x1: sx(p.x) + R, y0: sy(p.y) - R, y1: sy(p.y) + R }));
  for (let i = 1; i < line.length; i++) {
    const [ax, ay] = line[i - 1];
    const [bx, by] = line[i];
    const steps = Math.ceil(Math.hypot(bx - ax, by - ay) / 6);
    for (let k = 0; k <= steps; k++) {
      const x = ax + ((bx - ax) * k) / steps;
      const y = ay + ((by - ay) * k) / steps;
      boxes.push({ x0: x - 3, x1: x + 3, y0: y - 3, y1: y + 3 });
    }
  }
  const hits = (b) => boxes.some((o) => b.x0 < o.x1 && o.x0 < b.x1 && b.y0 < o.y1 && o.y0 < b.y1);
  const inside = (b) => b.x0 >= M.l && b.x1 <= W - M.r && b.y0 >= 0 && b.y1 <= H - M.b;
  const order = [...points].sort((a, b) => (onFrontier.has(b) - onFrontier.has(a)) || (b.y - a.y));
  const placed = [];
  for (const p of order) {
    const on = onFrontier.has(p);
    // Two lines: the model (with its copies), then the build, and the engine
    // where two recipes run the same build. A phone's chart has room for the
    // first line only.
    const twin = points.some((q) => q.entry.recipe !== p.entry.recipe && q.entry.recipe.model === p.entry.recipe.model && q.entry.recipe.build === p.entry.recipe.build);
    const engine = twin ? ` · ${p.entry.recipe.engine.split(/[ (]/)[0]}` : '';
    const lines = compact ? [copiesName(p)] : [copiesName(p), `${recipeBuild(ix, p.entry.recipe).label}${engine}`];
    const w = Math.max(...lines.map((l) => l.length)) * NAME_PX;
    const h = lines.length * 15;
    const cx = sx(p.x);
    const cy = sy(p.y);
    const at = (x, top, anchor) => {
      // A callout centred over its point slides sideways to stay in the plot.
      if (anchor === 'middle') x = Math.min(Math.max(x, M.l + w / 2), W - M.r - w / 2);
      const x0 = anchor === 'start' ? x : anchor === 'end' ? x - w : x - w / 2;
      return { x, top, anchor, b: { x0, x1: x0 + w, y0: top, y1: top + h } };
    };
    const spots = [
      at(cx + 10, cy - h / 2, 'start'),
      at(cx - 10, cy - h / 2, 'end'),
      at(cx, cy - 10 - h, 'middle'),
      at(cx, cy + 10, 'middle'),
      at(cx + 8, cy - h - 4, 'start'),
      at(cx + 8, cy + 4, 'start'),
      at(cx - 8, cy - h - 4, 'end'),
      at(cx - 8, cy + 4, 'end'),
      // Farther out, so a crowded chart can still name its points (not on a
      // phone, where a label that far off reads as another point's).
      ...(compact ? [] : [22, 36, 50]).flatMap((d) => [
        at(cx, cy - d - h, 'middle'), at(cx, cy + d, 'middle'),
        at(cx + d * 0.7, cy - d - h / 2, 'start'), at(cx + d * 0.7, cy + d - h / 2, 'start'),
        at(cx - d * 0.7, cy - d - h / 2, 'end'), at(cx - d * 0.7, cy + d - h / 2, 'end')
      ])
    ];
    const spot = spots.find((o) => inside(o.b) && !hits(o.b)) ?? (on ? spots.find((o) => inside(o.b)) ?? spots[0] : null);
    if (!spot) continue;
    boxes.push(spot.b);
    placed.push({ ...spot, lines, on });
  }
  return placed;
}

function chart(ix, url, n, method, plotted, frontier, size) {
  const { W, H, M, ticks } = SIZES[size];
  const onFrontier = new Set(frontier);
  const xTop = Math.max(...plotted.map((p) => p.x)) * 1.08;
  const xStep = niceStep(xTop / ticks);
  const xMax = Math.ceil(xTop / xStep) * xStep;
  const sx = (x) => M.l + (x / xMax) * (W - M.l - M.r);
  // The score axis spans the points and their margins, not 0 to 100, so
  // close scores aren't squashed together at the top.
  const lo = Math.min(...plotted.map((p) => p.y - p.m));
  const hi = Math.max(...plotted.map((p) => p.y + p.m));
  const yStep = Math.max(1, niceStep(Math.max(hi - lo, 4) / ticks));
  const yMin = Math.max(0, Math.floor((lo - yStep * 0.3) / yStep) * yStep);
  const yMax = Math.min(100, Math.ceil((hi + yStep * 0.3) / yStep) * yStep);
  const sy = (y) => H - M.b - ((y - yMin) / (yMax - yMin)) * (H - M.t - M.b);
  const xTicks = Array.from({ length: Math.round(xMax / xStep) + 1 }, (_, i) => i * xStep);
  const yTicks = Array.from({ length: Math.round((yMax - yMin) / yStep) + 1 }, (_, i) => yMin + i * yStep);
  const callouts = placeCallouts(ix, plotted, onFrontier, frontier.map((p) => [sx(p.x), sy(p.y)]), sx, sy, W, H, M, size === 'narrow');
  const measure = method === 'mean' ? 'score' : 'win rate';
  const speed = (p) => (p.copies > 1 ? `${p.copies} × ${fmt1(p.x / p.copies)} = ${fmt1(p.x)} t/s in all` : `${fmt1(p.x)} t/s`);
  const title = (p) => `${copiesName(p)} · ${recipeBuild(ix, p.entry.recipe).label}, ${p.copies > 1 ? `${p.copies} copies on ${plural(p.per)} each` : `on ${plural(p.used)}`}: ${speed(p)}, ${measure} ${fmt0(p.y)}${p.m ? ` ± ${fmt0(Math.max(1, p.m))}` : ''}${onFrontier.has(p) ? ' · on the frontier' : ''}`;
  const line = frontier.map((p) => `${sx(p.x).toFixed(1)},${sy(p.y).toFixed(1)}`).join(' ');
  const yLabel = method === 'mean' ? 'Score (mean, above chance)' : 'Win rate (%)';
  const fmtX = (t) => (Number.isInteger(xStep) ? fmt0(t) : fmt1(t));

  return html`<svg class="frontier-chart ${size}" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="Decode speed against ${measure} for ${plotted.length} ranked recipes on ${plural(n)}; ${frontier.length} on the frontier">
  <g class="grid">${yTicks.map((t) => html`<line x1="${M.l}" x2="${W - M.r}" y1="${sy(t)}" y2="${sy(t)}"></line>`)}</g>
  <g class="axis">
    <line x1="${M.l}" x2="${W - M.r}" y1="${H - M.b}" y2="${H - M.b}"></line>
    ${xTicks.map((t) => html`<text x="${sx(t)}" y="${H - M.b + 18}" text-anchor="middle">${fmtX(t)}</text>`)}
    ${yTicks.map((t) => html`<text x="${M.l - 10}" y="${sy(t) + 4}" text-anchor="end">${t}</text>`)}
    <text class="title" x="${(M.l + W - M.r) / 2}" y="${H - 12}" text-anchor="middle">Decode speed on ${plural(n)} (tokens/s${plotted.some((p) => p.copies > 1) ? ', copies summed' : ''})</text>
    <text class="title" x="14" y="${(M.t + H - M.b) / 2}" text-anchor="middle" transform="rotate(-90 14 ${(M.t + H - M.b) / 2})">${yLabel}</text>
  </g>
  <g class="err">${plotted.filter((p) => p.m).map((p) => html`<line x1="${sx(p.x).toFixed(1)}" x2="${sx(p.x).toFixed(1)}" y1="${sy(p.y - p.m).toFixed(1)}" y2="${sy(p.y + p.m).toFixed(1)}"></line>`)}</g>
  ${frontier.length > 1 ? html`<polyline class="frontier-line" points="${line}"></polyline>` : ''}
  ${plotted.filter((p) => !onFrontier.has(p)).concat(frontier).map((p) => html`<a class="pt ${sparkClass(p)}${onFrontier.has(p) ? ' on' : ''}" href="${url(recipePath(p.entry.recipe))}"><title>${title(p)}</title><circle cx="${sx(p.x).toFixed(1)}" cy="${sy(p.y).toFixed(1)}" r="5.5"></circle></a>`)}
  <g class="callouts">${callouts.map((c) => html`<text class="${c.on ? 'on' : ''}" x="${c.x.toFixed(1)}" y="${(c.top + 11).toFixed(1)}" text-anchor="${c.anchor}"><tspan x="${c.x.toFixed(1)}">${c.lines[0]}</tspan>${c.lines[1] ? html`<tspan class="build" x="${c.x.toFixed(1)}" dy="15">${c.lines[1]}</tspan>` : ''}</text>`)}</g>
</svg>`;
}

// Picks are the frontier itself, which runs from the most capable recipe to
// the fastest. With more than four, the cards show the two ends and two
// between; the chart shows them all.
function pickCards(ix, url, method, frontier) {
  let picks = [...frontier];
  if (picks.length > MAX_CARDS) {
    const last = picks.length - 1;
    picks = [picks[0], picks[Math.round(last / 3)], picks[Math.round((last * 2) / 3)], picks[last]];
  }
  const measure = method === 'mean' ? 'score' : 'win rate';
  return html`<ol class="pick-cards" aria-label="Picks on the frontier, most capable first">
    ${picks.map((p, i) => {
      const prev = picks[i - 1];
      const only = picks.length === 1;
      const label = only ? 'Best pick' : i === 0 ? 'Most capable' : i === picks.length - 1 ? 'Fastest' : 'Faster';
      // Compare the rounded scores the cards show, so the numbers add up.
      const drop = prev ? Math.round(prev.y) - Math.round(p.y) : 0;
      const trade = prev
        ? `${fmt1(p.x - prev.x)} t/s faster than ${copiesName(prev)}, ${drop > 0 ? `${drop} lower ${measure}` : `the same ${measure}`}`
        : only ? 'The only ranked recipe with a measured speed here' : `Highest ${measure} of any recipe that fits`;
      return html`<li class="pick-card">
      <span class="label">${label}</span>
      <a class="name" href="${url(recipePath(p.entry.recipe))}">${copiesName(p)}</a>
      <p class="value"><strong>${fmt0(p.y)}</strong><span>${method === 'mean' ? `score${p.m ? ` ± ${fmt0(Math.max(1, p.m))}` : ''}` : '% won'}</span><span class="mono">${fmt1(p.x)} t/s${p.copies > 1 ? ' in all' : ''}</span></p>
      <p>${recipeBuild(ix, p.entry.recipe).label} · ${howRun(p)}</p>
      <p class="trade">${trade}</p>
    </li>`;
    })}
  </ol>`;
}

function emptyState(url, n, need, keys, fit, withSpeed, scope) {
  return html`<div class="frontier-empty">
  <svg class="frontier-ghost" viewBox="0 0 1296 400" preserveAspectRatio="none" aria-hidden="true">
    <g class="grid">${[24, 90, 156, 222, 288].map((y) => html`<line x1="64" x2="1264" y1="${y}" y2="${y}"></line>`)}</g>
    <line class="base" x1="64" x2="1264" y1="354" y2="354"></line>
  </svg>
  <div class="frontier-empty-note">
    <h3>No picks yet: not enough scores to draw the frontier</h3>
    <p>None of the ${plural(fit, 'recipe')} that fit ${plural(n)} has scores that count on ${need} of the ${keys} benchmarks it needs to be ranked ${scope}, so none can be placed on the chart. Each one appears here at its measured decode speed once it does.</p>
    <p class="small">${withSpeed} of the ${fit} already have a decode speed measured on ${plural(n)}; what’s missing is scores on their exact builds.</p>
    <a class="button secondary" href="${url('contribute/')}">Submit a score</a>
  </div>
</div>`;
}

export function renderPicks({ ix, url, n, category, method }) {
  const { config } = ix;
  const categories = [{ id: 'all', name: 'All' }, ...config.categories];
  const keysOf = (cat) => ix.benchmarkList.filter((b) => cat === 'all' || b.categories.includes(cat));
  const scope = category === 'all' ? 'overall' : `on ${categories.find((c) => c.id === category).name.toLowerCase()}`;
  const { fit, withSpeed, plotted, noSpeed, frontier } = frontierPoints(ix, n, category, method);
  const { keys, need } = ix.standingsFor(n).ranking(category, method);
  const unplotted = noSpeed.length
    ? `Ranked but not plotted, with no speed measured on ${plural(n)}: ${noSpeed.map((e) => e.recipe.title).join('; ')}.`
    : '';

  const body = plotted.length === 0
    ? emptyState(url, n, need, keys.length, fit, withSpeed, scope)
    : html`<div class="picks-grid">
    <div class="picks-chart">
      <div class="chart-legend" aria-hidden="true">${[...new Set(plotted.map(sparkClass))].sort().map((c) => html`<span><i class="dot ${c}"></i>${plural(Number(c.slice(1)))} per copy</span>`)}<span><i class="dot ring"></i>On the frontier</span></div>
      ${chart(ix, url, n, method, plotted, frontier, 'wide')}${chart(ix, url, n, method, plotted, frontier, 'narrow')}
    </div>
    ${pickCards(ix, url, method, frontier)}
  </div>`;

  const footnote = plotted.length
    ? `Every recipe that fits is plotted, each scored as if it were the one representing its model.${plotted.some((p) => p.copies > 1) ? ` A recipe whose smallest setup fits more than once on ${plural(n)} is also plotted as that many independent copies (marked 2×, 3× and so on), at their decode speeds added together: that is total throughput when serving several requests at once, not the speed of one request.` : ''}${frontier.length === 1 ? ' A frontier line needs at least two ranked recipes.' : ''} ${method === 'mean' ? 'The score axis starts where the points do, not at 0, and each point’s bar is its 95% range from sampling the benchmarks’ tasks: points whose bars overlap are not reliably different. ' : ''}Speeds are single-request decode as measured by each recipe’s author, on their own workload, so treat small gaps as noise. Hover a point for its details; click it for the recipe. ${unplotted}`
    : unplotted;

  return html`<section class="wrap section" id="picks" aria-labelledby="picks-title" style="padding-top:40px">
  <div class="picks-head">
    <h2 id="picks-title">Best picks for ${plural(n)}</h2>
    <p>Every pick is on the frontier: nothing that fits is both faster and more capable</p>
  </div>
  <nav class="chip-group picks-chips" aria-label="Benchmark category for picks">
    ${categories.map((cat) => html`<a class="chip" href="${url(leaderboardPath(n, cat.id, method))}"${cat.id === category ? html` aria-current="page"` : ''}>${cat.name}<small>${keysOf(cat.id).length}</small></a>`)}
  </nav>
  ${body}
  ${footnote ? html`<p class="footnote">${footnote.trim()}</p>` : ''}
</section>`;
}
