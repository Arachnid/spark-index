// Formatting shared by the leaderboard and recipe pages.

import { html } from '../html.mjs';
import { fmt0, fmt1, plural } from './layout.mjs';
import { sparkRange, speedAt, usedSparks } from '../rank.mjs';

export const MARKS = { lab: '', independent: '●', 'other-lab': '○', spark: '◆' };
export const PROVENANCE_TEXT = {
  lab: 'reported by the developer',
  independent: 'independent run',
  'other-lab': 'from another lab’s comparison table',
  spark: 'run on a DGX Spark'
};

export function leaderboardPath(n, category, method) {
  return `sparks/${n}/` + (category === 'all' ? '' : `${category}/`) + (method === 'h2h' ? 'head-to-head/' : '');
}

export function recipePath(recipe) {
  return `recipes/${recipe.id}/`;
}

export function buildOf(ix, modelId, buildId) {
  return ix.models.get(modelId)?.builds?.[buildId ?? 'release'];
}

export function recipeBuild(ix, recipe) {
  return buildOf(ix, recipe.model, recipe.build);
}

// Short tag shown under a score that doesn't count.
export function statusTag(ix, score, status) {
  if (status === 'build') return `@${buildOf(ix, score.model, score.build).format.split(/[ ,(]/)[0]}`;
  if (status === 'model-version') return ix.models.get(score.model).name;
  if (status === 'test-version') return score.benchmark_version;
  if (status === 'sample') return 'subset';
  return '';
}

// Why a score doesn't count, in a sentence fragment.
export function statusWhy(ix, score, status, recipe) {
  const benchmark = ix.benchmarks.get(score.benchmark);
  if (status === 'build') {
    return `measured on ${buildOf(ix, score.model, score.build).label}; this recipe runs ${recipeBuild(ix, recipe).label}`;
  }
  if (status === 'model-version') return `measured on ${ix.models.get(score.model).name}, a different version of the model`;
  if (status === 'test-version') return `measured on ${benchmark.name} ${score.benchmark_version}; this site ranks on ${benchmark.version}`;
  if (status === 'sample') return `measured on a subset (${score.subset})`;
  return 'counts';
}

export function scoreSource(score) {
  const parts = [PROVENANCE_TEXT[score.provenance], score.setting, score.source.title, score.source.date].filter(Boolean);
  return parts.join(' · ');
}

export function heatClass(pct) {
  if (pct >= 80) return 'h4';
  if (pct >= 60) return 'h3';
  if (pct >= 40) return 'h2';
  if (pct >= 20) return 'h1';
  return 'h0';
}

// Recipe summary lines used in tables and cards.
export function recipeLines(ix, recipe, n) {
  const build = recipeBuild(ix, recipe);
  const used = n ? usedSparks(recipe, n) : null;
  const speed = used ? speedAt(recipe, used) : null;
  const size = build.size_gb ? ` · ${fmt0(build.size_gb)} GB` : '';
  return {
    name: build.label,
    by: build.by ?? recipe.author,
    range: sparkRange(recipe) + size,
    used,
    speed,
    run: [
      recipe.sparks.length > 1 && used ? `on ${used}` : null,
      speed?.decode_tps ? `${fmt0(speed.decode_tps)} t/s` : null
    ].filter(Boolean).join(' · ')
  };
}

export function speedText(speed) {
  if (!speed) return 'no speed data';
  const parts = [];
  if (speed.decode_tps) parts.push(`${fmt1(speed.decode_tps)} t/s decode`);
  if (speed.prefill_tps) parts.push(`${fmt0(speed.prefill_tps)} t/s prefill${speed.prefill_prompt ? ` (${speed.prefill_prompt})` : ''}`);
  if (speed.ttft_ms) parts.push(`${fmt0(speed.ttft_ms)} ms to first token`);
  return parts.join(', ') || 'no speed data';
}

export function sparkCountLabel(n) {
  return plural(n);
}

export const NUM = { fmt0, fmt1 };

export function sectionHead(num, title, aside) {
  return html`<div class="section-head"><span class="num">${num}</span><h2>${title}</h2>${aside ? html`<p>${aside}</p>` : ''}</div>`;
}
