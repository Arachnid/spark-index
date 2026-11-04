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

const LOGO = html`<svg width="22" height="22" viewBox="0 0 22 22" aria-hidden="true"><rect x="1" y="2" width="20" height="7.5" fill="none" stroke="currentColor" stroke-width="2"/><rect x="1" y="12.5" width="20" height="7.5" fill="currentColor"/></svg>`;

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
