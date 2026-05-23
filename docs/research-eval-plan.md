# Research eval plan

This is the next eval layer beyond the original `docs/eval-plan.md`.
The goal is to make the local `omlx` path strong enough to compare with
Werewolf-specific and agentic benchmarks while keeping the DuckDB Quack game
engine as the source of truth.

## Target benchmark parity

- **WOLF-style deception split**: keep deception production separate from
  deception detection, and report judge metadata with every score.
- **Werewolf Arena-style social deduction metrics**: report vote accuracy,
  accusation accuracy, survival curves, and wolf consensus behavior, not only
  win rate.
- **GameBench-style strategic reasoning scenarios**: compare the same model
  under local-core, larger-roster, high-temperature, and no-thinking-budget
  profiles.
- **Framework-grade reproducibility**: every run writes a manifest with
  profile hash, model, provider, scenario id, generation settings, roster, git
  commit, and run id.

## Current implementation

- Durable logs now include derived `statement` events for public utterances,
  `belief` events for private suspicion/knowledge markers, and
  `wolf-consensus` events for night coordination.
- `eval/aggregate.ts` adds:
  - `strategy`: vote accuracy, accusation accuracy, town-only accuracy, seer
    reveal rate, doctor save value.
  - `trust_dynamics`: suspicion separation between wolves and town,
    special-role false positives, peer-assessment hooks.
  - extended `deception`: precision, recall, F1, category histogram, judge
    disagreement rate.
  - `game_shape.mean_survival_curve` and wolf-consensus rates.
- `eval/run.ts` writes `manifest.json` beside `scorecard.json` and
  `gates.json`.
- `eval/report.ts` compares run directories and emits Markdown/JSON tables
  with bootstrap confidence intervals over per-game outcomes.
- `eval/promptfooconfig.yaml` and `eval/providers/werewolf-run.ts` wire the
  existing Node runner into promptfoo as a custom TypeScript provider.
- `eval/inspect/werewolf_task.py` wraps the Node runner as an Inspect AI task
  so research runs can be packaged with named scorers.

## Recommended workflow

1. Start local omlx and the lab web server:

   ```bash
   make web
   ```

2. Run the daily local research smoke:

   ```bash
   make eval-mini
   ```

3. Compare recent runs:

   ```bash
   node --import tsx eval/report.ts eval/runs --out eval/runs/report.md --json eval/runs/report.json
   ```

4. For a promptfoo matrix run:

   ```bash
   npm run eval:matrix
   ```

   promptfoo's current SQLite dependency supports Node 20-25. On hosts where
   the default `node` is newer, run the matrix through the one-off Node 24
   command above instead of changing the system Node.

5. For Inspect AI packaging:

   ```bash
   uv run --project eval/inspect inspect eval/inspect/werewolf_task.py@werewolf_omlx_mini
   ```

## Open research hooks

- `self-assessment` and `peer-assessment` events are supported by the
  aggregator but are not emitted by the live game loop yet. They are the next
  place to add active model-graded social reasoning without changing scorecard
  shape.
- Hosted provider baselines remain manual-cost runs. Local `omlx` baselines are
  the default regression signal.
