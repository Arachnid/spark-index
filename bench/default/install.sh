# The install step for a recipe described by its bench.yaml: get the recipe's
# repository onto the head Spark, then run its setup command there. A recipe
# with an install.sh of its own runs that instead.
#
# Workers are not touched: every multi-Spark recipe we script sets up its own
# workers from the head, over SSH, in its setup or start script.

dir=$(recipe_dir)
if [ -n "${SPARKPLUG_RECIPE_DIR:-}" ]; then
  # Your own checkout, with your settings in it: used as it is.
  [ -d "$dir" ] || die "--recipe-dir $dir does not exist on $(hostname)"
  if [ -n "${SPARKPLUG_REF:-}" ] && [ -d "$dir/.git" ]; then
    log "note: bench.yaml pins $SPARKPLUG_REF for $SPARKPLUG_SPARKS Sparks; $dir is at $(git -C "$dir" rev-parse --abbrev-ref HEAD), and is left as it is"
  fi
else
  [ -n "${SPARKPLUG_REPO:-}" ] || die "bench.yaml has no repo, and there is no install.sh"
  need_cmd git
  clone_or_update "$SPARKPLUG_REPO" "$dir" "${SPARKPLUG_REF:-}"
fi

if [ -n "${SPARKPLUG_SETUP:-}" ]; then
  cd "$dir"
  log "setup: $SPARKPLUG_SETUP"
  bash -c "$SPARKPLUG_SETUP" </dev/null
fi
