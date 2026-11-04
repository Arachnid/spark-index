// Speed against score for every ranked recipe that fits n Sparks, with a line
// through the ones on the frontier: the fastest recipe at each level of score.

import { html } from '../html.mjs';
import { plural, fmt0, fmt1 } from './layout.mjs';
import { minSparks, usedSparks, speedAt, paretoFrontier } from '../rank.mjs';
import { recipePath, recipeBuild, sectionHead } from './common.mjs';

// Two fixed sizes, so text stays at its real size: a wide chart, and a
// narrow one swapped in on phones by CSS.
const SIZES = {
  wide: { W: 960, H: 420, M: { l: 56, r: 28, t: 20, b: 56 } },
  narrow: { W: 360, H: 340, M: { l: 40, r: 14, t: 16, b: 52 } }
};

function niceStep(raw) {
  const p = 10 ** Math.floor(Math.log10(raw));
  return [1, 2, 2.5, 5, 10].map((m) => m * p).find((s) => s >= raw);
}

// Every recipe that fits, scored as if it were the one representing its model
// (so a model's other recipes can sit on the frontier too).
export function frontierPoints(ix, n, category, method) {
  const plotted = [];
  const noSpeed = [];
  let unranked = 0;
  for (const recipe of ix.recipes.filter((r) => minSparks(r) <= n)) {
    const r = ix.standingsFor(n, recipe).ranking(category, method);
    const entry = r.ranked.find((e) => e.recipe === recipe);
    if (!entry) {
      unranked++;
      continue;
    }
    const used = usedSparks(recipe, n);
    const tps = speedAt(recipe, used)?.decode_tps;
    if (tps === undefined) noSpeed.push(entry);
    else plotted.push({ x: tps, y: entry.score.value, entry, used });
  }
  return { plotted, noSpeed, unranked, frontier: paretoFrontier(plotted) };
}

function chart(ix, url, n, method, plotted, frontier, size) {
  const { W, H, M } = SIZES[size];
  const onFrontier = new Set(frontier);
  const xTop = Math.max(...plotted.map((p) => p.x)) * 1.08;
  const xStep = niceStep(xTop / (size === 'wide' ? 5 : 3));
  const xMax = Math.ceil(xTop / xStep) * xStep;
  const sx = (x) => M.l + (x / xMax) * (W - M.l - M.r);
  const sy = (y) => H - M.b - (y / 100) * (H - M.t - M.b);
  const xTicks = Array.from({ length: Math.round(xMax / xStep) + 1 }, (_, i) => i * xStep);
  const yTicks = [0, 20, 40, 60, 80, 100];
  const unit = method === 'percentile' ? 'index' : '% won';

  // Direct labels for frontier points. Each tries right, left, above and
  // below its point, and takes the first spot that stays inside the plot and
  // clears every point and every label already placed.
  const R = 9;
  const boxes = plotted.map((p) => ({ x0: sx(p.x) - R, x1: sx(p.x) + R, y0: sy(p.y) - R, y1: sy(p.y) + R }));
  const hits = (b) => boxes.some((o) => b.x0 < o.x1 && o.x0 < b.x1 && b.y0 < o.y1 && o.y0 < b.y1);
  const inside = (b) => b.x0 >= M.l && b.x1 <= W - M.r && b.y0 >= 0 && b.y1 <= H - M.b;
  const labels = [];
  for (const p of [...frontier].sort((a, b) => b.y - a.y)) {
    const text = p.entry.model.name;
    const w = text.length * 6.6;
    const cx = sx(p.x);
    const cy = sy(p.y);
    const spots = [
      { x: cx + 10, y: cy + 4, anchor: 'start', b: { x0: cx + 10, x1: cx + 10 + w, y0: cy - 8, y1: cy + 6 } },
      { x: cx - 10, y: cy + 4, anchor: 'end', b: { x0: cx - 10 - w, x1: cx - 10, y0: cy - 8, y1: cy + 6 } },
      { x: cx, y: cy - 12, anchor: 'middle', b: { x0: cx - w / 2, x1: cx + w / 2, y0: cy - 24, y1: cy - 10 } },
      { x: cx, y: cy + 22, anchor: 'middle', b: { x0: cx - w / 2, x1: cx + w / 2, y0: cy + 10, y1: cy + 24 } }
    ];
    const spot = spots.find((o) => inside(o.b) && !hits(o.b)) ?? spots.find((o) => inside(o.b)) ?? spots[0];
    boxes.push(spot.b);
    labels.push({ ...spot, text });
  }

  const title = (p) => `${p.entry.model.name} · ${recipeBuild(ix, p.entry.recipe).label} on ${plural(p.used)}: ${fmt1(p.x)} t/s, ${unit} ${fmt0(p.y)}${onFrontier.has(p) ? ' · on the frontier' : ''}`;
  const line = frontier.map((p) => `${sx(p.x).toFixed(1)},${sy(p.y).toFixed(1)}`).join(' ');

  return html`<svg class="frontier-chart ${size}" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="Decode speed against ${unit} for ${plotted.length} ranked recipes on ${plural(n)}; ${frontier.length} on the frontier">
  <g class="grid">${yTicks.map((t) => html`<line x1="${M.l}" x2="${W - M.r}" y1="${sy(t)}" y2="${sy(t)}"></line>`)}</g>
  <g class="axis">
    <line x1="${M.l}" x2="${W - M.r}" y1="${H - M.b}" y2="${H - M.b}"></line>
    ${xTicks.map((t) => html`<text x="${sx(t)}" y="${H - M.b + 18}" text-anchor="middle">${Number.isInteger(xStep) ? fmt0(t) : fmt1(t)}</text>`)}
    ${yTicks.map((t) => html`<text x="${M.l - 10}" y="${sy(t) + 4}" text-anchor="end">${t}</text>`)}
    <text class="title" x="${(M.l + W - M.r) / 2}" y="${H - 12}" text-anchor="middle">Decode speed on ${plural(n)} (tokens/s)</text>
    <text class="title" x="16" y="${(M.t + H - M.b) / 2}" text-anchor="middle" transform="rotate(-90 16 ${(M.t + H - M.b) / 2})">${method === 'percentile' ? 'Index' : 'Win rate (%)'}</text>
  </g>
  ${frontier.length > 1 ? html`<polyline class="frontier-line" points="${line}"></polyline>` : ''}
  ${plotted.filter((p) => !onFrontier.has(p)).concat(frontier).map((p) => html`<a class="pt${onFrontier.has(p) ? ' on' : ''}" href="${url(recipePath(p.entry.recipe))}"><title>${title(p)}</title><circle cx="${sx(p.x).toFixed(1)}" cy="${sy(p.y).toFixed(1)}" r="5.5"></circle></a>`)}
  <g class="labels">${labels.map((l) => html`<text x="${l.x.toFixed(1)}" y="${l.y.toFixed(1)}" text-anchor="${l.anchor}">${l.text}</text>`)}</g>
</svg>`;
}

export function renderFrontier({ ix, url, n, category, method, num }) {
  const scope = category === 'all' ? 'overall' : `on ${ix.config.categories.find((c) => c.id === category).name.toLowerCase()}`;
  const { plotted, noSpeed, unranked, frontier } = frontierPoints(ix, n, category, method);
  const measure = method === 'percentile' ? 'index' : 'head-to-head win rate';
  const notes = [
    noSpeed.length ? `${plural(noSpeed.length, 'ranked recipe')} ${noSpeed.length === 1 ? 'has' : 'have'} no speed measured on ${plural(n)}, so ${noSpeed.length === 1 ? 'isn’t' : 'aren’t'} plotted: ${noSpeed.map((e) => e.recipe.title).join('; ')}.` : '',
    unranked ? `${plural(unranked, 'recipe')} that fit ${unranked === 1 ? 'isn’t' : 'aren’t'} ranked ${scope} yet.` : ''
  ].filter(Boolean).join(' ');

  if (plotted.length === 0) {
    return html`<section class="wrap section" id="frontier">
  ${sectionHead(num, 'Speed and score')}
  <p class="empty">No recipe that fits ${plural(n)} is ranked ${scope} yet, so there is no frontier to draw. Once recipes have enough scores that count, each one appears here at its measured decode speed, with a line through the fastest recipe at each level of ${measure}.${notes ? ` ${notes}` : ''}</p>
</section>`;
  }

  return html`<section class="wrap section" id="frontier">
  ${sectionHead(num, 'Speed and score', `Recipes that fit ${plural(n)}, ranked ${scope}`)}
  <div class="chart-legend"><span><i class="dot on"></i>On the frontier: nothing that fits is both faster and better</span><span><i class="dot"></i>Other ranked recipes</span></div>
  <div class="chart-wrap">${chart(ix, url, n, method, plotted, frontier, 'wide')}${chart(ix, url, n, method, plotted, frontier, 'narrow')}</div>
  <ol class="list frontier-list">
    ${frontier.map((p) => html`<li><span><a href="${url(recipePath(p.entry.recipe))}">${p.entry.model.name}</a><span class="why">${recipeBuild(ix, p.entry.recipe).label} on ${plural(p.used)}</span></span><span class="mono">${fmt1(p.x)} t/s · ${method === 'percentile' ? 'index' : 'win rate'} ${fmt0(p.y)}</span></li>`)}
  </ol>
  <p class="footnote">Each model’s other recipes are plotted too, each scored as if it were the one representing the model. Speeds are single-request decode as measured by each recipe’s author, on their own workload, so treat small gaps as noise. ${notes}</p>
</section>`;
}
