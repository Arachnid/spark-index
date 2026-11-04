import { html } from '../html.mjs';

// Builds links relative to the configured base path, e.g. "/spark-index/".
export function makeUrl(config) {
  const base = config.base_path.endsWith('/') ? config.base_path : `${config.base_path}/`;
  return (path = '') => base + path.replace(/^\//, '');
}

export function plural(n, word = 'Spark') {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

export function fmt1(v) {
  return v.toLocaleString('en-GB', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
}

export function fmt0(v) {
  return v.toLocaleString('en-GB', { maximumFractionDigits: 0 });
}

// The Spark Plug mark: a plug on the diagonal, its spark at the gap. Metal
// parts take the text colour; the spark is the accent.
const LOGO = html`<svg class="mark" width="28" height="28" viewBox="0 0 32 32" aria-hidden="true">
  <g transform="translate(17.6 14.4) rotate(45) translate(0 -16.5)" fill="currentColor">
    <rect x="-2.2" y="0" width="4.4" height="3.2" rx="0.8"/>
    <rect x="-1.1" y="3" width="2.2" height="1.6"/>
    <rect x="-3.6" y="4.6" width="7.2" height="10.6" rx="2" fill="none" stroke="currentColor" stroke-width="2.2"/>
    <rect x="-6.2" y="15.2" width="12.4" height="4.6" rx="0.9"/>
    <rect x="-4.2" y="19.6" width="8.4" height="6.8"/>
    <path d="M-4.2 22.3L4.2 21.1M-4.2 25L4.2 23.8" fill="none" style="stroke: var(--paper)" stroke-width="1.1"/>
    <rect x="-1.1" y="26.2" width="2.2" height="2.8"/>
    <path d="M3.2 26.2V31.6H-0.6" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="square"/>
  </g>
  <path d="M5.6 17.5L6.8 20.2L9.5 21.4L6.8 22.6L5.6 25.3L4.4 22.6L1.7 21.4L4.4 20.2Z" transform="rotate(45 5.6 21.4)" style="fill: var(--accent)"/>
</svg>`;

export function layout({ config, url, title, description, current, body }) {
  const nav = [
    ['leaderboard', 'Leaderboard', url('')],
    ['methodology', 'Methodology', url('methodology/')],
    ['contribute', 'Contribute', url('contribute/')]
  ];
  return html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title ? `${title} · ${config.name}` : config.name}</title>
<meta name="description" content="${description ?? config.tagline}">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Archivo:wdth,wght@62..125,100..900&amp;family=IBM+Plex+Mono:wght@400;500;600&amp;display=swap">
<link rel="icon" href="${url('favicon.svg')}" type="image/svg+xml">
<link rel="stylesheet" href="${url('style.css')}">
</head>
<body>
<header class="site-header">
  <div class="wrap">
    <a class="brand" href="${url('')}">${LOGO}${config.name}</a>
    <nav class="nav" aria-label="Primary">
      ${nav.map(([id, label, href]) => html`<a href="${href}"${current === id ? html` aria-current="page"` : ''}>${label}</a>`)}
    </nav>
    <a class="button" href="${url('contribute/')}">Submit a score</a>
  </div>
</header>
<main>
${body}
</main>
<footer class="site-footer">
  <div class="wrap">
    <p>${config.name} is independent and not affiliated with NVIDIA or any model developer. DGX Spark is a trademark of NVIDIA Corporation.</p>
    <p>Every number links to its source. Data and code live at <a href="${config.repo}">${config.repo.replace('https://', '')}</a>; corrections and new scores are welcome as pull requests.</p>
  </div>
</footer>
<script src="${url('sort.js')}" defer></script>
</body>
</html>
`;
}
