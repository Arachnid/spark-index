import { html } from '../html.mjs';
import { layout } from './layout.mjs';

export function renderMethodology({ ix, url }) {
  const { config } = ix;
  const body = html`<div class="wrap">
  <section class="hero" style="padding-bottom:8px">
    <p class="kicker">How the ranking works</p>
    <h1 style="margin:0;font-size:clamp(34px,4.5vw,54px);line-height:1.05;font-weight:760;font-stretch:112%">Methodology</h1>
  </section>
  <div class="method-grid">
    <div>
      <h3>Recipes</h3>
      <p>A recipe is a specific build of a model, the engine that serves it, and the numbers of Sparks its author supports. Running a recipe on more Sparks makes it faster, not smarter, so it stays one entry with one set of scores and a speed for each Spark count.</p>
      <p>For a cluster of a given size, each model is represented by one recipe: the one whose counted scores rank best. Ties go to more bits per weight, then to the recipe that can use more of your Sparks, then to faster measured decode.</p>
    </div>
    <div>
      <h3>What counts</h3>
      <p>A score counts toward a recipe’s ranking only if it was measured on the recipe’s exact model version and build, on the benchmark version this site ranks on, using the full test set.</p>
      <p>When several scores count for the same benchmark, the one from the most independent source is used: a run on a Spark, then an independent leaderboard, then the developer. Among those, the highest is used, which is usually the model’s top reasoning setting.</p>
      <p>Scores measured on another build or quantization, an earlier or later version of the model, another version of the benchmark, or a subset of it, are shown with what they were measured on and left out. Scores for a different parameter size of a model are not shown at all.</p>
    </div>
    <div>
      <h3>Ranking with gaps</h3>
      <p>Each counted score becomes a percentile among the models that fit your cluster, so a hard benchmark weighs the same as an easy one. A recipe’s index is the mean of those percentiles, and it needs scores that count on at least ${Math.round(config.ranking.min_coverage * 100)}% of a category’s benchmarks to be ranked.</p>
      <p>Head-to-head ranking instead counts wins on benchmarks both recipes have scores for, so a recipe can’t rise by skipping hard benchmarks.</p>
      <p>The best picks at the top of each leaderboard are the recipes on the frontier of measured decode speed against that score: no other recipe that fits is both faster and ranked higher. Every recipe that fits is considered, not only the one representing its model.</p>
    </div>
    <div>
      <h3>Provenance</h3>
      <p>Each score records who measured it: the model’s developer, an independent leaderboard, another lab’s comparison table, or a run on a DGX Spark. Developer scores are taken as measured on the release they shipped, unless the source says otherwise.</p>
      <p>Runs on a Spark with a recipe’s exact build are what this site exists to collect.</p>
    </div>
  </div>
  <section class="section">
    <div class="section-head"><span class="num">—</span><h2>Benchmarks</h2></div>
    <ul class="list" style="margin-top:16px">
      ${ix.benchmarkList.map((b) => html`<li><span><b><a href="${b.url}">${b.name}</a></b> · ranks on ${b.version} · ${b.metric}<span class="why">${b.description}${b.harness ? ` Harness: ${b.harness}.` : ''}</span></span><span class="small muted">${b.categories.map((c) => config.categories.find((x) => x.id === c).name).join(', ')}</span></li>`)}
    </ul>
  </section>
</div>`;
  return layout({ config, url, title: 'Methodology', current: 'methodology', body });
}

export function renderContribute({ ix, url }) {
  const { config } = ix;
  const repo = config.repo;
  const body = html`<div class="wrap">
  <section class="hero" style="padding-bottom:8px">
    <p class="kicker">Add a score, a recipe or a model</p>
    <h1 style="margin:0;font-size:clamp(34px,4.5vw,54px);line-height:1.05;font-weight:760;font-stretch:112%">Contribute</h1>
  </section>
  <div class="prose">
    <p>Everything on this site is generated from small YAML files in <a href="${repo}/tree/main/data">the repository’s data folder</a>. Adding a score is one new file in a pull request; the site rebuilds itself when it is merged.</p>
    <h2>Submit a score</h2>
    <p>Create <code>data/scores/&lt;model-id&gt;/&lt;benchmark-id&gt;-&lt;short-name&gt;.yaml</code>. For example, a run of Mia’s GLM-5.3-Flash recipe would go in <code>data/scores/glm-5.3-flash/terminal-bench-4-my-run.yaml</code>. If you ran it on a Spark, say which build and how many Sparks:</p>
    <pre><code>benchmark: terminal-bench
benchmark_version: "4.0"
value: 31.8
build: mia-exl3-4bpw              # a build id from data/models/glm-5.3-flash.yaml
provenance: spark                 # lab | independent | other-lab | spark
sparks: 2
setting: Claude Code, 5 trials per task
source:
  title: My run log
  url: https://github.com/you/your-run-logs
  date: "2026-11-04"</code></pre>
    <p>Then run <code>npm run check</code> to validate the data and build the site locally. The checks also run on every pull request.</p>
    <h2>Add a recipe</h2>
    <p>Add the build to the model’s <code>builds</code> list if it isn’t there, then create <code>data/recipes/&lt;recipe-id&gt;.yaml</code> with the Spark counts the recipe supports and any measured speeds.</p>
    <h2>Add a model or a benchmark</h2>
    <p>Create <code>data/models/&lt;model-id&gt;.yaml</code> or <code>data/benchmarks/&lt;benchmark-id&gt;.yaml</code>. The full field reference, with examples, is in <a href="${repo}/blob/main/CONTRIBUTING.md">CONTRIBUTING.md</a>.</p>
    <p><a class="button" href="${repo}/blob/main/CONTRIBUTING.md">Read the contributor guide</a></p>
  </div>
</div>`;
  return layout({ config, url, title: 'Contribute', current: 'contribute', body });
}
