// Speed against score for every ranked recipe that fits n Sparks, with a line
// through the ones on the frontier: the fastest recipe at each level of score.

import { html } from '../html.mjs';
import { plural, fmt0, fmt1 } from './layout.mjs';
import { minSparks, usedSparks, speedAt, paretoFrontier } from '../rank.mjs';
import { recipePath, recipeBuild, sectionHead } from './common.mjs';

// Two fixed sizes, so text stays at its real size: a wide chart, and a
// narrow one swapped in on phones by CSS.
const SIZES = {
  wide: { W: 960, H: 440, M: { l: 56, r: 28, t: 24, b: 56 }, ticks: 5 },
  narrow: { W: 360, H: 380, M: { l: 40, r: 14, t: 20, b: 52 }, ticks: 3 }
};
const NAME_PX = 6.6; // approximate width per character, 12px sans
const SUB_PX = 6.7; // 11px mono

function niceStep(raw) {
  const p = 10 ** Math.floor(Math.log10(raw));
  return [1, 2, 2.5, 5, 10].map((m) => m * p).find((s) => s >= raw);
}

// Every recipe that fits, scored as if it were the one representing its model
// (so a model's other recipes can sit on the frontier too).
export function frontierPoints(ix, n, category, method) {
  const fit = ix.recipes.filter((r) => minSparks(r) <= n);
  const plotted = [];
  const noSpeed = [];
  for (const recipe of fit) {
    const entry = ix.standingsFor(n, recipe).ranking(category, method).ranked.find((e) => e.recipe === recipe);
    if (!entry) continue;
    const used = usedSparks(recipe, n);
    const tps = speedAt(recipe, used)?.decode_tps;
    if (tps === undefined) noSpeed.push(entry);
    else plotted.push({ x: tps, y: entry.score.value, entry, used });
  }
  const withSpeed = fit.filter((r) => speedAt(r, usedSparks(r, n))?.decode_tps !== undefined).length;
  return { fit: fit.length, withSpeed, plotted, noSpeed, frontier: paretoFrontier(plotted) };
}

// A callout for every point: frontier points get the name and their numbers,
// the rest the name alone. Each tries eight spots around its point and takes
// the first inside the plot that clears every point, the frontier line and
// every callout placed so far. Frontier callouts go first and are always
// drawn; another callout with no clear spot is left off (its point still
// has a hover title).
function placeCallouts(ix, points, onFrontier, line, sx, sy, W, H, M, unitShort, compact) {
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
  const sameModel = (p) => points.filter((q) => q.entry.model === p.entry.model).length > 1;
  const order = [...points].sort((a, b) => (onFrontier.has(b) - onFrontier.has(a)) || (b.y - a.y));
  const placed = [];
  for (const p of order) {
    const on = onFrontier.has(p);
    const name = sameModel(p) && !compact ? `${p.entry.model.name} · ${recipeBuild(ix, p.entry.recipe).label}` : p.entry.model.name;
    const sub = on ? `${fmt1(p.x)} t/s · ${unitShort} ${fmt0(p.y)}` : '';
    const w = Math.max(name.length * NAME_PX, sub.length * SUB_PX);
    const h = sub ? 28 : 14;
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
      at(cx - 8, cy + 4, 'end')
    ];
    const spot = spots.find((o) => inside(o.b) && !hits(o.b)) ?? (on ? spots.find((o) => inside(o.b)) ?? spots[0] : null);
    if (!spot) continue;
    boxes.push(spot.b);
    placed.push({ ...spot, name, sub, on });
  }
  return placed;
}

function axes(W, H, M, xTicks, sx, sy, xLabel, yLabel, fmtX) {
  const yTicks = [0, 20, 40, 60, 80, 100];
  return html`<g class="grid">${yTicks.map((t) => html`<line x1="${M.l}" x2="${W - M.r}" y1="${sy(t)}" y2="${sy(t)}"></line>`)}</g>
  <g class="axis">
    <line x1="${M.l}" x2="${W - M.r}" y1="${H - M.b}" y2="${H - M.b}"></line>
    ${xTicks.map((t) => html`<text x="${sx(t)}" y="${H - M.b + 18}" text-anchor="middle">${fmtX(t)}</text>`)}
    ${yTicks.map((t) => html`<text x="${M.l - 10}" y="${sy(t) + 4}" text-anchor="end">${t}</text>`)}
    <text class="title" x="${(M.l + W - M.r) / 2}" y="${H - 12}" text-anchor="middle">${xLabel}</text>
    <text class="title" x="14" y="${(M.t + H - M.b) / 2}" text-anchor="middle" transform="rotate(-90 14 ${(M.t + H - M.b) / 2})">${yLabel}</text>
  </g>`;
}

function chart(ix, url, n, method, plotted, frontier, size) {
  const { W, H, M, ticks } = SIZES[size];
  const onFrontier = new Set(frontier);
  const xTop = Math.max(...plotted.map((p) => p.x)) * 1.08;
  const xStep = niceStep(xTop / ticks);
  const xMax = Math.ceil(xTop / xStep) * xStep;
  const sx = (x) => M.l + (x / xMax) * (W - M.l - M.r);
  const sy = (y) => H - M.b - (y / 100) * (H - M.t - M.b);
  const xTicks = Array.from({ length: Math.round(xMax / xStep) + 1 }, (_, i) => i * xStep);
  const unitShort = method === 'percentile' ? 'index' : 'won';
  const callouts = placeCallouts(ix, plotted, onFrontier, frontier.map((p) => [sx(p.x), sy(p.y)]), sx, sy, W, H, M, unitShort, size === 'narrow');
  const title = (p) => `${p.entry.model.name} · ${recipeBuild(ix, p.entry.recipe).label} on ${plural(p.used)}: ${fmt1(p.x)} t/s, ${method === 'percentile' ? 'index' : 'win rate'} ${fmt0(p.y)}${onFrontier.has(p) ? ' · on the frontier' : ''}`;
  const line = frontier.map((p) => `${sx(p.x).toFixed(1)},${sy(p.y).toFixed(1)}`).join(' ');
  const yLabel = method === 'percentile' ? 'Index' : 'Win rate (%)';

  return html`<svg class="frontier-chart ${size}" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="Decode speed against ${yLabel.toLowerCase()} for ${plotted.length} ranked recipes on ${plural(n)}; ${frontier.length} on the frontier">
  ${axes(W, H, M, xTicks, sx, sy, `Decode speed on ${plural(n)} (tokens/s)`, yLabel, (t) => (Number.isInteger(xStep) ? fmt0(t) : fmt1(t)))}
  ${frontier.length > 1 ? html`<polyline class="frontier-line" points="${line}"></polyline>` : ''}
  ${plotted.filter((p) => !onFrontier.has(p)).concat(frontier).map((p) => html`<a class="pt${onFrontier.has(p) ? ' on' : ''}" href="${url(recipePath(p.entry.recipe))}"><title>${title(p)}</title><circle cx="${sx(p.x).toFixed(1)}" cy="${sy(p.y).toFixed(1)}" r="5.5"></circle></a>`)}
  <g class="callouts">${callouts.map((c) => html`<text class="${c.on ? 'on' : ''}" x="${c.x.toFixed(1)}" y="${(c.top + 11).toFixed(1)}" text-anchor="${c.anchor}">${c.name}</text>${c.sub ? html`<text class="sub" x="${c.x.toFixed(1)}" y="${(c.top + 25).toFixed(1)}" text-anchor="${c.anchor}">${c.sub}</text>` : ''}`)}</g>
</svg>`;
}

// The same frame with nothing on it, and a note over it saying what is missing.
function emptyChart(ix, url, n, method, need, keys, fit, withSpeed, scope) {
  const { W, H, M } = SIZES.wide;
  const sy = (y) => H - M.b - (y / 100) * (H - M.t - M.b);
  const yTicks = [0, 20, 40, 60, 80, 100];
  return html`<div class="frontier-empty">
  <svg class="frontier-ghost" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">
    <g class="grid">${yTicks.map((t) => html`<line x1="${M.l}" x2="${W - M.r}" y1="${sy(t)}" y2="${sy(t)}"></line>`)}</g>
    <line class="base" x1="${M.l}" x2="${W - M.r}" y1="${H - M.b}" y2="${H - M.b}"></line>
  </svg>
  <div class="frontier-empty-note">
    <h3>Not enough scores to draw the frontier yet</h3>
    <p>None of the ${plural(fit, 'recipe')} that fit ${plural(n)} has scores that count on ${need} of the ${keys} benchmarks it needs to be ranked ${scope}, so none can be placed on the chart. Each one appears here at its measured decode speed once it does.</p>
    <p class="small">${withSpeed} of the ${fit} already have a decode speed measured on ${plural(n)}; what’s missing is scores on their exact builds.</p>
    <a class="button secondary" href="${url('contribute/')}">Submit a score</a>
  </div>
</div>`;
}

export function renderFrontier({ ix, url, n, category, method, num }) {
  const scope = category === 'all' ? 'overall' : `on ${ix.config.categories.find((c) => c.id === category).name.toLowerCase()}`;
  const { fit, withSpeed, plotted, noSpeed, frontier } = frontierPoints(ix, n, category, method);
  const { keys, need } = ix.standingsFor(n).ranking(category, method);
  const unplotted = noSpeed.length
    ? `Ranked but not plotted, with no speed measured on ${plural(n)}: ${noSpeed.map((e) => e.recipe.title).join('; ')}.`
    : '';

  if (plotted.length === 0) {
    return html`<section class="wrap section" id="frontier">
  ${sectionHead(num, 'Speed and score', `Recipes that fit ${plural(n)}, ranked ${scope}`)}
  ${emptyChart(ix, url, n, method, need, keys.length, fit, withSpeed, scope)}
  ${unplotted ? html`<p class="footnote">${unplotted}</p>` : ''}
</section>`;
  }

  return html`<section class="wrap section" id="frontier">
  ${sectionHead(num, 'Speed and score', `Recipes that fit ${plural(n)}, ranked ${scope}`)}
  <div class="chart-legend"><span><i class="dot on"></i>On the frontier: nothing that fits is both faster and better</span><span><i class="dot"></i>Other ranked recipes</span></div>
  <div class="chart-wrap">${chart(ix, url, n, method, plotted, frontier, 'wide')}${chart(ix, url, n, method, plotted, frontier, 'narrow')}</div>
  <p class="footnote">Each model’s other recipes are plotted too, each scored as if it were the one representing the model.${frontier.length === 1 ? ' A frontier line needs at least two ranked recipes.' : ''} Speeds are single-request decode as measured by each recipe’s author, on their own workload, so treat small gaps as noise. Hover a point for its details; click it for the recipe. Where callouts would overlap, only the frontier’s are shown. ${unplotted}</p>
</section>`;
}
