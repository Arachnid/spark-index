# Spark Plug

Capability rankings for open-weight models that run on one or more NVIDIA DGX Sparks.

The site ranks **recipes**: a specific build of a model, the engine that serves it, and the numbers of Sparks it supports. It ranks them on benchmark scores, not speed, and a score only counts if it was measured on the recipe's exact model version and build, on the benchmark version the site uses. Everything else is shown, labelled with what it was measured on, and left out of the ranking.

Live site: https://sparkplug.sh/

## How it's built

- `data/` holds one small YAML file per benchmark, model, recipe and score. Pull requests that add a score are a single new file.
- `npm run build` validates the data, works out the standings for every cluster size, and writes a static site to `dist/`: a leaderboard for each Spark count, category and ranking method, a page per recipe, and `data.json` with all the inputs.
- Pushes to `main` deploy to GitHub Pages. Pull requests run the same checks.

```sh
npm ci
npm run check                        # validate, test, build
BASE_PATH=/ npm run build && npm run serve   # preview at http://localhost:8080/
```

Node 20 or later. The site needs no JavaScript to read; a small script adds column sorting.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for the file formats and the rules for what counts. The most useful contribution is a run of an existing recipe, on a Spark, on one of the ranked benchmarks. `npm run bench` automates one: see [bench/README.md](bench/README.md).

## Settings

`site.config.yaml` holds the site name, the repository link, the base path, the Spark counts to build pages for, the benchmark categories, and the share of a category's benchmarks a recipe needs scores on to be ranked.

## Licence

Code: MIT. Data in `data/`: CC BY 4.0. Each score links to its original source.
