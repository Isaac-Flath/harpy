# /// script
# requires-python = ">=3.10"
# dependencies = []
# ///
"""
Python REPL host for RLM investigations.

Run via: uv run repl-host.py

Hosts the REPL where an investigator model iteratively writes Python to explore
the knowledge base. Exposes builtins (kb_search, kb_read, llm_query, rlm_query,
FINAL, ...) in the namespace the model's code executes in.

Protocol:
- stdin / stdout: length-prefixed JSON frames for {op: ...} commands from the
  TS side, and {stdout, stderr, ...} replies back. Model's print() output also
  goes here (captured before reply is sent, so it doesn't collide).
- fd 3 / fd 4: RPC channel. When model code calls e.g. llm_query(), the host
  writes {method, params} to fd 4 and blocks reading from fd 3 for the response.

Ops from the TS side:
  {op: "load_context", context: <any JSON>}  -> loads ns['context'] (the leads)
  {op: "exec", code: "..."}                  -> execs in ns; returns result frame
  {op: "shutdown"}                           -> exits

Result frame shape:
  {stdout: str, stderr: str, error: str|null, final_answer: any|missing}

Note on the `context` name: the Python variable the model sees is `context`
(paper-compat — renaming it would cost grep-parity with the RLM paper and
retrain the model's expectations). Internally, TypeScript refers to it as
`leads`.
"""

import json
import os
import sys
import traceback
from io import StringIO


# ---------- fd 3/4 duplex RPC to host ----------
CTRL_IN = os.fdopen(3, "rb", buffering=0)   # host -> child (RPC responses)
CTRL_OUT = os.fdopen(4, "wb", buffering=0)  # child -> host (RPC requests)


def _ctrl_send(msg: dict) -> None:
    payload = json.dumps(msg).encode("utf-8")
    CTRL_OUT.write(len(payload).to_bytes(4, "big") + payload)


def _ctrl_recv() -> dict:
    header = CTRL_IN.read(4)
    if len(header) < 4:
        raise RuntimeError("RPC channel closed")
    n = int.from_bytes(header, "big")
    body = b""
    while len(body) < n:
        chunk = CTRL_IN.read(n - len(body))
        if not chunk:
            raise RuntimeError("RPC channel closed mid-frame")
        body += chunk
    return json.loads(body)


def _rpc(method: str, **params):
    _ctrl_send({"method": method, "params": params})
    response = _ctrl_recv()
    if "error" in response:
        raise RuntimeError(f"{method} failed: {response['error']}")
    return response["result"]


# ---------- builtins exposed in the model's namespace ----------
def kb_search(query, k=5, scope="wiki", pattern=None):
    return _rpc("kb_search", query=query, k=k, scope=scope, pattern=pattern)


def kb_read(path):
    return _rpc("kb_read", path=path)


def llm_query(prompt, model=None):
    return _rpc("llm_query", prompt=prompt, model=model)


def llm_query_batched(prompts, model=None):
    return _rpc("llm_query_batched", prompts=prompts, model=model)


def rlm_query(prompt, context=None, model=None):
    return _rpc("rlm_query", prompt=prompt, context=context, model=model)


def rlm_query_batched(prompts, contexts=None, model=None):
    return _rpc("rlm_query_batched", prompts=prompts, contexts=contexts, model=model)


def FINAL(answer):
    ns["__final__"] = answer


def FINAL_VAR(name):
    ns["__final__"] = ns[name]


def SHOW_VARS():
    return {
        k: type(v).__name__
        for k, v in ns.items()
        if not k.startswith("_") and not callable(v)
    }


# ---------- namespace init ----------
ns: dict = {
    "kb_search": kb_search,
    "kb_read": kb_read,
    "llm_query": llm_query,
    "llm_query_batched": llm_query_batched,
    "rlm_query": rlm_query,
    "rlm_query_batched": rlm_query_batched,
    "FINAL": FINAL,
    "FINAL_VAR": FINAL_VAR,
    "SHOW_VARS": SHOW_VARS,
}


# ---------- main op loop over stdin ----------
def _send_reply(msg: dict) -> None:
    sys.__stdout__.write(json.dumps(msg) + "\n")
    sys.__stdout__.flush()


while True:
    line = sys.stdin.readline()
    if not line:
        break
    try:
        cmd = json.loads(line)
    except json.JSONDecodeError as e:
        _send_reply({"error": f"bad JSON on stdin: {e}"})
        continue

    op = cmd.get("op")
    if op == "load_context":
        ns["context"] = cmd.get("context")
        _send_reply({"ok": True})

    elif op == "exec":
        code = cmd.get("code", "")
        old_stdout, old_stderr = sys.stdout, sys.stderr
        sys.stdout, sys.stderr = StringIO(), StringIO()
        ns.pop("__final__", None)
        err = None
        try:
            exec(compile(code, "<model>", "exec"), ns)
        except SystemExit:
            raise
        except BaseException:
            err = traceback.format_exc()
        finally:
            captured_stdout = sys.stdout.getvalue()
            captured_stderr = sys.stderr.getvalue()
            sys.stdout, sys.stderr = old_stdout, old_stderr

        result = {
            "stdout": captured_stdout[:20000],
            "stdout_truncated": len(captured_stdout) > 20000,
            "stderr": captured_stderr,
        }
        if err:
            result["error"] = err
        if "__final__" in ns:
            result["final_answer"] = ns["__final__"]
        _send_reply(result)

    elif op == "shutdown":
        break

    else:
        _send_reply({"error": f"unknown op: {op}"})
