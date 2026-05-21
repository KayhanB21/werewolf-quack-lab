# Committed baselines

This directory holds reference scorecards that we expect the eval framework
to reproduce. `tests/eval-aggregate.mjs` asserts that `fixtures.json` matches
the live aggregator output for `eval/fixtures/`, so any change to the
aggregator that shifts a metric will fail CI loudly.

## Files

- `fixtures.json` — aggregation of `eval/fixtures/*.jsonl`. Deterministic
  (`meta.generated_at` and per-game `path` fields are stripped before
  commit). Regenerated whenever fixtures or aggregator semantics change.
- `stub-smoke.json` (lazy) — output of a live `eval/profiles/stub-smoke.json`
  run. Commit by hand after a clean run; serves as the "did the pipeline
  itself break?" tripwire across the orchestrator + container + Quack stack.

## Regenerating `fixtures.json`

```bash
node -e "import('./eval/aggregate.mjs').then(async m => {
  const g = await m.loadGameLogs('eval/fixtures');
  const s = m.aggregate(g);
  delete s.meta.generated_at;
  for (const x of s.per_game) delete x.path;
  process.stdout.write(JSON.stringify(s, null, 2) + '\n');
})" > eval/baselines/fixtures.json
```

## Regenerating `stub-smoke.json`

Requires Docker + the running web server.

```bash
make web &              # in a separate shell
make eval-run PROFILE=eval/profiles/stub-smoke.json
# inspect eval/runs/stub-smoke-<stamp>/scorecard.json, then:
cp eval/runs/stub-smoke-<stamp>/scorecard.json eval/baselines/stub-smoke.json
```

Strip `meta.generated_at` and `per_game[].path` before committing if you
want byte-exact diff checks.
