# /// script
# requires-python = ">=3.10"
# dependencies = []
# ///
"""
Triage demand signals with cheap fanout LLM calls.

This is the reference composition of three harpy/agentkb primitives:

  1. SQL (read-only) against agentkb's demand SQLite for exact filtering.
     The DB path comes from `agentkb settings --json` — never hardcoded.
  2. `harpy_llm.llm_query_batched` to fan one cheap prompt per signal out
     to a fast model (server auth + model resolution live in llm-server.ts).
  3. `agentkb demand annotate` to write verdicts back. Writes always go
     through the agentkb CLI, never raw SQL — the DB is agentkb's to own.

Usage:
  python scripts/demand_triage.py --limit 25                 # dry run
  python scripts/demand_triage.py --topic "retrieval evals"  # score vs a topic
  python scripts/demand_triage.py --limit 100 --apply        # write verdicts
  python scripts/demand_triage.py --model openai-codex/gpt-5.4-mini ...
"""

from __future__ import annotations

import argparse
import json
import re
import sqlite3
import subprocess
import sys
from pathlib import Path

from harpy_llm import llm_query_batched

BATCH_SIZE = 20  # prompts per llm_query_batched call, for progress reporting

# ---------------------------------------------------------------------------
# Step 1: SQL — exact filtering the search index can't do
# ---------------------------------------------------------------------------

def demand_db_path() -> Path:
    """Ask agentkb where its demand data lives instead of hardcoding."""
    out = subprocess.run(
        ["agentkb", "settings", "--json"], capture_output=True, text=True, check=True
    )
    root = json.loads(out.stdout)["resolved_paths"]["demand_root"]
    return Path(root) / "data" / "idea_review.sqlite"


def fetch_unreviewed_signals(db: Path, limit: int) -> list[dict]:
    """Unreviewed signals, highest engagement first."""
    uri = f"file:{db}?mode=ro"  # read-only: this script never writes SQL
    with sqlite3.connect(uri, uri=True) as conn:
        conn.row_factory = sqlite3.Row
        rows = conn.execute(
            """
            SELECT s.id, s.question, s.verbatim, s.asker_context, s.engagement,
                   src.kind AS source_kind, src.title AS source_title
            FROM signals s
            JOIN signal_sources src ON src.id = s.source_id
            LEFT JOIN signal_annotations a ON a.signal_id = s.id
            WHERE COALESCE(a.verdict, 'unreviewed') = 'unreviewed'
            ORDER BY s.engagement DESC, s.id
            LIMIT ?
            """,
            (limit,),
        ).fetchall()
    return [dict(r) for r in rows]

# ---------------------------------------------------------------------------
# Step 2: fanout — one cheap LLM call per signal
# ---------------------------------------------------------------------------

def triage_prompt(signal: dict, topic: str | None) -> str:
    angle = (
        f'Judge relevance to the topic: "{topic}".'
        if topic
        else "Judge whether this is worth answering as public content "
        "(a short video, post, or FAQ entry) for an AI-engineering audience."
    )
    return f"""You triage audience demand signals for a content creator.
{angle}

Signal:
  question: {signal["question"]}
  verbatim: {signal["verbatim"] or "(none)"}
  asker context: {signal["asker_context"] or "(unknown)"}
  source: {signal["source_kind"]} — {signal["source_title"]}
  engagement: {signal["engagement"]}

Reply with ONLY a JSON object, no markdown fence:
{{"verdict": "good" | "maybe" | "bad", "priority": 0-3, "reason": "<one sentence>"}}"""


def parse_triage(raw: str) -> dict:
    """Parse the model's JSON, tolerating stray text or fences."""
    match = re.search(r"\{.*\}", raw, re.DOTALL)
    try:
        parsed = json.loads(match.group(0) if match else raw)
        verdict = parsed.get("verdict", "maybe")
        if verdict not in ("good", "maybe", "bad"):
            verdict = "maybe"
        priority = min(3, max(0, int(parsed.get("priority", 0))))
        return {"verdict": verdict, "priority": priority, "reason": str(parsed.get("reason", ""))}
    except (json.JSONDecodeError, AttributeError, TypeError, ValueError):
        return {"verdict": "maybe", "priority": 0, "reason": f"unparseable reply: {raw[:80]}"}


def fan_out(signals: list[dict], topic: str | None, model: str | None) -> list[dict]:
    verdicts: list[dict] = []
    for start in range(0, len(signals), BATCH_SIZE):
        batch = signals[start : start + BATCH_SIZE]
        prompts = [triage_prompt(s, topic) for s in batch]
        print(f"  fanout: signals {start + 1}-{start + len(batch)} of {len(signals)}...")
        replies = llm_query_batched(prompts, model=model)
        verdicts.extend(parse_triage(r) for r in replies)
    return verdicts

# ---------------------------------------------------------------------------
# Step 3: report, and optionally write back through the agentkb CLI
# ---------------------------------------------------------------------------

def apply_annotations(results: list[tuple[dict, dict]]) -> None:
    for signal, verdict in results:
        subprocess.run(
            [
                "agentkb", "demand", "annotate", str(signal["id"]),
                "--verdict", verdict["verdict"],
                "--priority", str(verdict["priority"]),
                "--notes", f"[triage] {verdict['reason']}",
            ],
            check=True,
            capture_output=True,
        )
    print(f"applied {len(results)} annotations via `agentkb demand annotate`")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.split("\n", 1)[0])
    ap.add_argument("--limit", type=int, default=25, help="max signals to triage")
    ap.add_argument("--topic", help="score relevance to this topic instead of general content-worthiness")
    ap.add_argument("--model", help='override model, e.g. "openai-codex/gpt-5.4-mini"')
    ap.add_argument("--apply", action="store_true", help="write verdicts back via agentkb (default: dry run)")
    args = ap.parse_args()

    db = demand_db_path()
    signals = fetch_unreviewed_signals(db, args.limit)
    if not signals:
        print("no unreviewed signals found")
        return
    print(f"triaging {len(signals)} unreviewed signals from {db}")

    verdicts = fan_out(signals, args.topic, args.model)
    results = sorted(
        zip(signals, verdicts),
        key=lambda r: ({"good": 0, "maybe": 1, "bad": 2}[r[1]["verdict"]], -r[1]["priority"]),
    )

    print()
    for signal, verdict in results:
        print(f"[{verdict['verdict']:>5} p{verdict['priority']}] #{signal['id']} {signal['question'][:90]}")
        print(f"          {verdict['reason'][:110]}")

    if args.apply:
        apply_annotations(results)
    else:
        print("\ndry run — rerun with --apply to write verdicts via agentkb")


if __name__ == "__main__":
    main()
