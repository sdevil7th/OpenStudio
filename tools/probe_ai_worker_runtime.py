#!/usr/bin/env python3
"""
Local probe for the OpenStudio ACE-Step runtime bridge.

This script can:
- launch the persistent worker and verify the ready handshake
- submit a framed generate request and inspect the ack
- run one-shot generation with optional LM-mismatch / decode-stall debug flags
"""

from __future__ import annotations

import argparse
import json
import os
import socket
import struct
import subprocess
import sys
import threading
import time
import uuid
from copy import deepcopy
from pathlib import Path
from queue import Empty, Queue
from typing import Any

WORKER_PROTOCOL_VERSION = 2
DEFAULT_TIMEOUT_SEC = 120.0


def resolve_trace_root(explicit_root: str | None = None) -> Path:
    override = (explicit_root or os.environ.get("OPENSTUDIO_AI_TRACE_ROOT", "")).strip()
    if override:
        return Path(override).expanduser().resolve()

    if sys.platform == "win32":
        local_app_data = os.environ.get("LOCALAPPDATA", "").strip()
        if local_app_data:
            return Path(local_app_data).expanduser().resolve() / "OpenStudio" / "logs" / "ai" / "music-generation"
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Application Support" / "OpenStudio" / "logs" / "ai" / "music-generation"

    xdg_state_home = os.environ.get("XDG_STATE_HOME", "").strip()
    if xdg_state_home:
        return Path(xdg_state_home).expanduser().resolve() / "OpenStudio" / "logs" / "ai" / "music-generation"
    return Path.home() / ".local" / "state" / "OpenStudio" / "logs" / "ai" / "music-generation"


def recv_exact(connection: socket.socket, byte_count: int) -> bytes:
    chunks: list[bytes] = []
    remaining = byte_count
    while remaining > 0:
        data = connection.recv(remaining)
        if not data:
            raise ConnectionError("Socket closed before the framed payload was fully received.")
        chunks.append(data)
        remaining -= len(data)
    return b"".join(chunks)


def recv_framed_json(connection: socket.socket) -> dict[str, Any]:
    header = recv_exact(connection, 4)
    payload_length = struct.unpack(">I", header)[0]
    payload = recv_exact(connection, payload_length)
    parsed = json.loads(payload.decode("utf-8"))
    if not isinstance(parsed, dict):
        raise ValueError("Expected a JSON object response from the worker.")
    parsed["_framedPayloadLength"] = payload_length
    return parsed


def send_framed_json(connection: socket.socket, payload: dict[str, Any]) -> int:
    encoded = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    connection.sendall(struct.pack(">I", len(encoded)) + encoded)
    return len(encoded)


def stream_lines(
    process: subprocess.Popen[str],
    ready_queue: Queue[dict[str, Any]],
    event_queue: Queue[dict[str, Any]],
) -> None:
    assert process.stdout is not None
    for raw_line in process.stdout:
        line = raw_line.rstrip()
        if not line:
            continue
        print(f"[worker] {line}")
        try:
            parsed = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(parsed, dict):
            event_queue.put(parsed)
            if parsed.get("event") == "ready":
                ready_queue.put(parsed)


def build_params(args: argparse.Namespace) -> dict[str, Any]:
    return {
        "prompt": args.prompt,
        "lyrics": args.lyrics,
        "negativePrompt": "",
        "seed": args.seed,
        "duration": args.duration,
        "bpm": args.bpm,
        "timesignature": args.time_signature,
        "language": args.language,
        "keyscale": args.key_scale,
        "cfg_scale": args.cfg_scale,
        "temperature": args.temperature,
        "top_p": args.top_p,
        "top_k": args.top_k,
        "min_p": args.min_p,
        "runtimeProfile": args.runtime_profile,
        "lmModel": args.lm_model,
        "generationMode": args.generation_mode,
        "auto_metas": args.auto_metas,
        "guidance_scale": args.guidance_scale,
        "inferenceSteps": args.steps,
        "inferMethod": args.infer_method,
        "debugForceLmShapeMismatch": args.force_lm_shape_mismatch,
        "debugDecodeStallSeconds": args.debug_decode_stall_seconds,
    }


def wait_for_ready(ready_queue: Queue[dict[str, Any]], timeout_sec: float) -> dict[str, Any]:
    try:
        return ready_queue.get(timeout=timeout_sec)
    except Empty as exc:
        raise TimeoutError("Timed out waiting for the worker ready handshake.") from exc


def wait_for_terminal_event(
    event_queue: Queue[dict[str, Any]],
    timeout_sec: float,
) -> dict[str, Any]:
    deadline = time.monotonic() + timeout_sec
    last_event: dict[str, Any] | None = None
    while time.monotonic() < deadline:
        remaining = max(0.1, deadline - time.monotonic())
        try:
            event = event_queue.get(timeout=min(1.0, remaining))
        except Empty:
            continue
        last_event = event
        if event.get("state") in {"done", "error", "cancelled"}:
            return event
    raise TimeoutError(f"Timed out waiting for a terminal worker event. Last event: {last_event}")


def make_output_path(args: argparse.Namespace, suffix: str) -> Path:
    output_dir = Path(args.output_dir).expanduser().resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    return output_dir / f"probe_{suffix}_{int(time.time())}.wav"


def run_persistent_probe(args: argparse.Namespace) -> dict[str, Any]:
    python = Path(args.python).expanduser().resolve()
    script = Path(args.script).expanduser().resolve()
    checkpoint_root = Path(args.checkpoint_root).expanduser().resolve()
    request_id = str(uuid.uuid4())

    command = [
        str(python),
        str(script),
        "--worker",
        "--checkpoint-root",
        str(checkpoint_root),
        "--music-gen-model",
        args.music_gen_model,
    ]
    print(f"[probe] launching worker: {' '.join(command)}")
    process = subprocess.Popen(
        command,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1,
    )

    ready_queue: Queue[dict[str, Any]] = Queue()
    event_queue: Queue[dict[str, Any]] = Queue()
    ready: dict[str, Any] = {}
    reader = threading.Thread(
        target=stream_lines,
        args=(process, ready_queue, event_queue),
        name="ProbeWorkerReader",
        daemon=True,
    )
    reader.start()

    try:
        ready = wait_for_ready(ready_queue, args.ready_timeout_sec)
        print(
            "[probe] ready handshake:",
            json.dumps(
                {
                    "port": ready.get("port"),
                    "pid": ready.get("pid"),
                    "protocolVersion": ready.get("protocolVersion"),
                    "scriptVersion": ready.get("scriptVersion"),
                    "scriptPath": ready.get("scriptPath"),
                },
                indent=2,
            ),
        )

        output_path = make_output_path(args, "persistent")
        request_payload = {
            "command": "generate",
            "workflow": "text-to-music",
            "params": json.dumps(build_params(args), ensure_ascii=False),
            "output": str(output_path),
            "requestId": request_id,
            "protocolVersion": WORKER_PROTOCOL_VERSION,
            "scriptVersion": str(ready.get("scriptVersion") or ""),
        }

        with socket.create_connection(("127.0.0.1", int(ready["port"])), timeout=10.0) as connection:
            payload_bytes = send_framed_json(connection, request_payload)
            ack = recv_framed_json(connection)

        print(
            "[probe] worker ack:",
            json.dumps(
                {
                    "requestId": ack.get("requestId"),
                    "accepted": ack.get("accepted"),
                    "protocolVersion": ack.get("protocolVersion"),
                    "scriptVersion": ack.get("scriptVersion"),
                    "pid": ack.get("pid"),
                    "framedPayloadLength": ack.get("framedPayloadLength"),
                    "sentPayloadBytes": payload_bytes,
                },
                indent=2,
            ),
        )

        terminal = wait_for_terminal_event(event_queue, args.timeout_sec)
        print("[probe] terminal event:", json.dumps(terminal, indent=2))
        if output_path.exists():
            print(f"[probe] output file: {output_path}")
        return terminal
    finally:
        try:
            with socket.create_connection(("127.0.0.1", int(ready.get("port", 0))), timeout=3.0) as connection:
                send_framed_json(
                    connection,
                    {
                        "command": "shutdown",
                        "requestId": str(uuid.uuid4()),
                        "protocolVersion": WORKER_PROTOCOL_VERSION,
                        "scriptVersion": str(ready.get("scriptVersion") or ""),
                    },
                )
                print("[probe] shutdown ack:", json.dumps(recv_framed_json(connection), indent=2))
        except Exception:
            pass
        process.terminate()
        try:
            process.wait(timeout=5.0)
        except subprocess.TimeoutExpired:
            process.kill()


def run_one_shot_probe(args: argparse.Namespace) -> int:
    python = Path(args.python).expanduser().resolve()
    script = Path(args.script).expanduser().resolve()
    checkpoint_root = Path(args.checkpoint_root).expanduser().resolve()
    request_id = str(uuid.uuid4())
    output_path = make_output_path(args, "oneshot")

    command = [
        str(python),
        str(script),
        "--workflow",
        "text-to-music",
        "--params",
        json.dumps(build_params(args), ensure_ascii=False),
        "--output",
        str(output_path),
        "--request-id",
        request_id,
        "--checkpoint-root",
        str(checkpoint_root),
        "--music-gen-model",
        args.music_gen_model,
        "--session-mode",
        args.session_mode,
    ]
    print(f"[probe] launching one-shot: {' '.join(command)}")
    process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    assert process.stdout is not None
    for raw_line in process.stdout:
        print(f"[oneshot] {raw_line.rstrip()}")
    return_code = process.wait()
    print(f"[probe] one-shot exit code: {return_code}")
    if output_path.exists():
        print(f"[probe] output file: {output_path}")
    return return_code


def read_trace_terminal_summary(trace_path: Path) -> dict[str, Any]:
    last_payload: dict[str, Any] = {}
    if not trace_path.exists():
        return {}
    for raw_line in trace_path.read_text(encoding="utf-8").splitlines():
        raw_line = raw_line.strip()
        if not raw_line:
            continue
        try:
            parsed = json.loads(raw_line)
        except json.JSONDecodeError:
            continue
        if parsed.get("event") == "progress_payload":
            payload = parsed.get("payload")
            if isinstance(payload, dict):
                last_payload = payload
    return {
        "requestId": last_payload.get("requestId"),
        "state": last_payload.get("state"),
        "failureKind": last_payload.get("failureKind"),
        "tracePath": str(trace_path),
        "summaryPath": str(trace_path.with_suffix(".txt")),
        "lmStage": last_payload.get("lmStage"),
        "lmBackend": last_payload.get("lmBackend"),
        "runtimeProfile": last_payload.get("runtimeProfile"),
        "lmModel": last_payload.get("lmModel"),
        "error": last_payload.get("error") or last_payload.get("message"),
    }


def run_trace_summary(args: argparse.Namespace) -> None:
    trace_root = resolve_trace_root(args.trace_root)
    if not trace_root.exists():
        print(f"[probe] trace root does not exist: {trace_root}")
        return

    summaries: list[dict[str, Any]] = []
    for trace_path in sorted(trace_root.glob("*.jsonl"), key=lambda path: path.stat().st_mtime, reverse=True):
        summary = read_trace_terminal_summary(trace_path)
        if not summary:
            continue
        if summary.get("state") != "error":
            continue
        summaries.append(summary)
        if len(summaries) >= args.summary_limit:
            break

    print(f"[probe] trace root: {trace_root}")
    if not summaries:
        print("[probe] no failing traces found")
        return

    for index, summary in enumerate(summaries, start=1):
        print(
            json.dumps(
                {
                    "index": index,
                    "requestId": summary.get("requestId"),
                    "failureKind": summary.get("failureKind"),
                    "lmStage": summary.get("lmStage"),
                    "lmBackend": summary.get("lmBackend"),
                    "runtimeProfile": summary.get("runtimeProfile"),
                    "lmModel": summary.get("lmModel"),
                    "tracePath": summary.get("tracePath"),
                    "summaryPath": summary.get("summaryPath"),
                    "error": summary.get("error"),
                },
                ensure_ascii=True,
            )
        )


def run_lm_diagnostics(args: argparse.Namespace) -> None:
    lm_models = [
        item.strip()
        for item in str(args.diagnostic_lm_models or "").split(",")
        if item.strip()
    ] or ["acestep-5Hz-lm-0.6B", "acestep-5Hz-lm-1.7B"]

    for auto_metas in (True, False):
        for lm_model in lm_models:
            run_args = argparse.Namespace(**deepcopy(vars(args)))
            run_args.scenario = "persistent"
            run_args.generation_mode = "lm_first"
            run_args.auto_metas = auto_metas
            run_args.lm_model = lm_model
            print(
                f"[probe] lm-diagnostics combo auto_metas={auto_metas} lm_model={lm_model}"
            )
            try:
                terminal = run_persistent_probe(run_args)
                print(
                    "[probe] lm-diagnostics result:",
                    json.dumps(
                        {
                            "requestId": terminal.get("requestId"),
                            "state": terminal.get("state"),
                            "failureKind": terminal.get("failureKind"),
                            "lmStage": terminal.get("lmStage"),
                            "lmBackend": terminal.get("lmBackend"),
                            "tracePath": terminal.get("tracePath"),
                        },
                        ensure_ascii=False,
                    ),
                )
            except Exception as exc:
                print(
                    f"[probe] lm-diagnostics combo failed auto_metas={auto_metas} "
                    f"lm_model={lm_model}: {type(exc).__name__}: {exc}"
                )


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Probe the OpenStudio ACE-Step runtime bridge.")
    parser.add_argument("--python", help="Python interpreter to use")
    parser.add_argument("--script", default="tools/generate_music.py", help="Path to generate_music.py")
    parser.add_argument("--checkpoint-root", help="Pinned ACE-Step checkpoint root")
    parser.add_argument("--music-gen-model", default="acestep-v15-xl-turbo")
    parser.add_argument("--output-dir", default=str(Path.cwd() / "tmp"))
    parser.add_argument(
        "--scenario",
        choices=("persistent", "oneshot", "all", "lm-diagnostics", "summary"),
        default="all",
    )
    parser.add_argument("--session-mode", default="oneshot-probe")
    parser.add_argument("--ready-timeout-sec", type=float, default=15.0)
    parser.add_argument("--timeout-sec", type=float, default=DEFAULT_TIMEOUT_SEC)
    parser.add_argument("--trace-root", help="Override the OpenStudio AI trace root")
    parser.add_argument("--summary-limit", type=int, default=5)
    parser.add_argument(
        "--diagnostic-lm-models",
        default="acestep-5Hz-lm-0.6B,acestep-5Hz-lm-1.7B",
        help="Comma-separated LM checkpoint ids for lm-diagnostics mode",
    )
    parser.add_argument("--prompt", default="Warm cinematic synthwave with driving drums and airy pads")
    parser.add_argument("--lyrics", default="[Verse]\\nOpenStudio lights the scene\\n")
    parser.add_argument("--seed", type=int, default=0)
    parser.add_argument("--duration", type=float, default=30.0)
    parser.add_argument("--bpm", type=int, default=120)
    parser.add_argument("--time-signature", default="4/4")
    parser.add_argument("--language", default="en")
    parser.add_argument("--key-scale", default="C major")
    parser.add_argument("--cfg-scale", type=float, default=2.0)
    parser.add_argument("--temperature", type=float, default=0.85)
    parser.add_argument("--top-p", type=float, default=0.9)
    parser.add_argument("--top-k", type=int, default=0)
    parser.add_argument("--min-p", type=float, default=0.0)
    parser.add_argument("--steps", type=int, default=8)
    parser.add_argument("--runtime-profile", default="native-xl-turbo")
    parser.add_argument("--lm-model", default="auto")
    parser.add_argument(
        "--generation-mode",
        choices=("lm_first", "dit_manual"),
        default="lm_first",
    )
    parser.add_argument("--auto-metas", action=argparse.BooleanOptionalAction, default=True)
    parser.add_argument("--guidance-scale", type=float, default=7.0)
    parser.add_argument("--infer-method", choices=("ode", "sde"), default="ode")
    parser.add_argument("--force-lm-shape-mismatch", action="store_true")
    parser.add_argument("--debug-decode-stall-seconds", type=float, default=0.0)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    if args.scenario == "summary":
        run_trace_summary(args)
        return

    if args.scenario in {"persistent", "oneshot", "all", "lm-diagnostics"}:
        if not args.python:
            raise SystemExit("--python is required for this scenario.")
        if not args.checkpoint_root:
            raise SystemExit("--checkpoint-root is required for this scenario.")

    if args.scenario == "lm-diagnostics":
        run_lm_diagnostics(args)
        return

    if args.scenario in {"persistent", "all"}:
        run_persistent_probe(args)
    if args.scenario in {"oneshot", "all"}:
        run_one_shot_probe(args)


if __name__ == "__main__":
    main()
