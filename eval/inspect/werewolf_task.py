"""Inspect AI wrapper for werewolf-quack-lab.

The game engine and metrics stay in Node. Inspect is used as a research
packaging layer so experiment logs can carry named scores without duplicating
the DuckDB/Quack referee.

Run from the repo root after starting the lab web server:

    uv run --project eval/inspect inspect eval/inspect/werewolf_task.py@werewolf_omlx_mini
"""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

from inspect_ai import Task, task
from inspect_ai.dataset import Sample
from inspect_ai.scorer import Score, Target, scorer, mean
from inspect_ai.solver import TaskState, solver


ROOT = Path(__file__).resolve().parents[2]


@solver
def node_eval_runner(profile: str = "eval/profiles/omlx-qwen35-mini.json"):
    async def solve(state: TaskState, generate):
        out_dir = ROOT / "eval" / "runs" / "inspect-last"
        cmd = ["node", "--import", "tsx", "./eval/run.ts", profile, "--out", str(out_dir)]
        proc = subprocess.run(cmd, cwd=ROOT, text=True, capture_output=True, check=False)
        state.metadata["stdout"] = proc.stdout[-4000:]
        state.metadata["stderr"] = proc.stderr[-4000:]
        state.metadata["out_dir"] = str(out_dir)
        state.metadata["returncode"] = proc.returncode
        if proc.returncode == 0:
            state.output.completion = (out_dir / "scorecard.json").read_text()
        else:
            state.output.completion = json.dumps({"error": proc.stderr[-1000:], "returncode": proc.returncode})
        return state

    return solve


def _scorecard(state: TaskState) -> dict:
    try:
        return json.loads(state.output.completion)
    except Exception:
        return {}


@scorer(metrics=[mean()])
def valid_json_rate():
    async def score(state: TaskState, target: Target):
        sc = _scorecard(state)
        value = float(sc.get("prompt_following", {}).get("valid_json_rate", 0))
        return Score(value=value, explanation="Prompt-following JSON validity rate")

    return score


@scorer(metrics=[mean()])
def strategy_score():
    async def score(state: TaskState, target: Target):
        sc = _scorecard(state)
        value = float(sc.get("strategy", {}).get("town_vote_accuracy", 0))
        return Score(value=value, explanation="Town vote accuracy against true wolves")

    return score


@scorer(metrics=[mean()])
def deception_score():
    async def score(state: TaskState, target: Target):
        sc = _scorecard(state)
        value = sc.get("deception", {}).get("deception_detection_f1")
        return Score(value=float(value or 0), explanation="LLM-judged deception detection F1")

    return score


@task
def werewolf_omlx_mini():
    return Task(
        dataset=[Sample(input="Run local omlx werewolf research smoke", target="complete")],
        solver=node_eval_runner("eval/profiles/omlx-qwen35-mini.json"),
        scorer=[valid_json_rate(), strategy_score(), deception_score()],
    )
