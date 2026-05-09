#!/usr/bin/env python3
"""One-shot MiDashengLM analyzer service for OpenStudio."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import re
import sys
from typing import Any


MODEL_ID = "mispeech/midashenglm-7b-1021-bf16"


def read_json(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8-sig"))
    return value if isinstance(value, dict) else {}


def extract_json_object(text: str) -> dict[str, Any]:
    decoder = json.JSONDecoder()
    start = text.find("{")
    while start >= 0:
        try:
            value, _ = decoder.raw_decode(text[start:])
        except json.JSONDecodeError:
            start = text.find("{", start + 1)
            continue
        if isinstance(value, dict):
            return value
        start = text.find("{", start + 1)
    return {}


def normalize_list(value: Any, *, limit: int = 16) -> list[str]:
    if isinstance(value, list):
        result: list[str] = []
        for item in value:
            if isinstance(item, dict):
                text = str(item.get("summary") or item.get("description") or item.get("name") or "").strip()
            else:
                text = str(item).strip()
            if text:
                result.append(text)
        return result[:limit]
    if isinstance(value, str) and value.strip():
        return [part.strip() for part in re.split(r"[,;\n]", value) if part.strip()][:limit]
    return []


def normalize_confidence(value: Any) -> float | None:
    if isinstance(value, (int, float)):
        return max(0.0, min(1.0, float(value)))
    if isinstance(value, str):
        try:
            return max(0.0, min(1.0, float(value.strip().rstrip("%")) / (100.0 if "%" in value else 1.0)))
        except ValueError:
            return None
    return None


def deterministic_value(request: dict[str, Any], *keys: str) -> Any:
    analysis = request.get("deterministicAnalysis")
    if not isinstance(analysis, dict):
        analysis = request.get("measurements")
    if not isinstance(analysis, dict):
        return None
    for key in keys:
        if key in analysis:
            return analysis[key]
    return None


def normalize_summary(value: dict[str, Any], fallback_text: str, request: dict[str, Any]) -> dict[str, Any]:
    deterministic_bpm = deterministic_value(request, "bpm", "tempoBpm", "tempo")
    bpm = deterministic_bpm if isinstance(deterministic_bpm, (int, float)) else None
    deterministic_key = deterministic_value(request, "key", "musicalKey", "keyGuess")
    key_guess = str(
        deterministic_key
        or value.get("keyGuess")
        or value.get("key_guess")
        or value.get("key")
        or ""
    ).strip()
    production_notes = str(
        value.get("productionNotes")
        or value.get("production_notes")
        or value.get("mixNotes")
        or value.get("mix_notes")
        or ""
    ).strip()
    prompt_summary = str(
        value.get("promptReadySummary")
        or value.get("prompt_ready_summary")
        or value.get("summary")
        or fallback_text
    ).strip()
    return {
        "genre": str(value.get("genre") or "").strip(),
        "tempoFeel": str(value.get("tempoFeel") or value.get("tempo_feel") or "").strip(),
        "bpm": bpm,
        "keyGuess": key_guess,
        "instruments": normalize_list(value.get("instruments")),
        "vocals": str(value.get("vocals") or "").strip(),
        "arrangement": str(value.get("arrangement") or "").strip(),
        "mood": str(value.get("mood") or "").strip(),
        "productionNotes": production_notes,
        "mixIssues": normalize_list(value.get("mixIssues") or value.get("mix_issues")),
        "suggestedDawActions": normalize_list(
            value.get("suggestedDawActions")
            or value.get("suggested_daw_actions")
            or value.get("actions")
        ),
        "promptReadySummary": prompt_summary,
        "confidence": normalize_confidence(value.get("confidence")),
        "inferenceNotice": (
            "Semantic music fields are MiDashengLM model inferences. Exact measurements are null "
            "unless OpenStudio deterministic analyzers supplied them."
        ),
    }


def emit_failure(message: str, *, code: str, exit_code: int) -> None:
    print(
        json.dumps(
            {
                "ok": False,
                "failureCode": code,
                "error": message,
            },
            ensure_ascii=True,
        ),
        flush=True,
    )
    raise SystemExit(exit_code)


def run(request: dict[str, Any]) -> dict[str, Any]:
    clip = request.get("clip", {})
    if not isinstance(clip, dict):
        clip = {}
    audio_path = Path(str(clip.get("filePath") or clip.get("path") or "")).expanduser()
    if not audio_path.exists():
        emit_failure("Selected audio file was not found.", code="audio_understanding_audio_missing", exit_code=2)

    model_path = str(request.get("modelPath") or os.environ.get("OPENSTUDIO_MIDASHENGLM_MODEL_PATH") or "").strip()
    model_id = model_path or MODEL_ID
    prompt = str(request.get("prompt") or "").strip()
    instruction = (
        "Analyze this music/audio clip for a DAW assistant. Return only strict JSON with keys "
        "genre, tempoFeel, bpm, keyGuess, instruments, vocals, arrangement, mood, productionNotes, "
        "mixIssues, suggestedDawActions, promptReadySummary, and confidence. "
        "Do not invent exact BPM; use null for bpm unless it is provided by deterministic measurements. "
        "Make suggestedDawActions short human-readable DAW actions, not code."
    )
    if prompt:
        instruction += f" User intent: {prompt}"

    try:
        import torch
        from transformers import AutoModelForCausalLM, AutoProcessor, AutoTokenizer
    except Exception as exc:
        emit_failure(
            f"MiDashengLM dependencies are unavailable: {type(exc).__name__}: {exc}",
            code="audio_understanding_import_failed",
            exit_code=2,
        )

    try:
        model_kwargs: dict[str, Any] = {
            "trust_remote_code": True,
            "device_map": "auto",
        }
        if torch.cuda.is_available():
            model_kwargs["torch_dtype"] = torch.bfloat16
        model = AutoModelForCausalLM.from_pretrained(model_id, **model_kwargs)
        tokenizer = AutoTokenizer.from_pretrained(model_id, trust_remote_code=True)
        processor = AutoProcessor.from_pretrained(model_id, trust_remote_code=True)
        messages = [
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": instruction},
                    {"type": "audio", "path": str(audio_path)},
                ],
            }
        ]
        with torch.no_grad():
            model_inputs = processor.apply_chat_template(
                messages,
                tokenize=True,
                add_generation_prompt=True,
                add_special_tokens=True,
                return_dict=True,
            )
            model_dtype = getattr(model, "dtype", None)
            if model_dtype is None:
                model_inputs = model_inputs.to(device=model.device)
            else:
                model_inputs = model_inputs.to(device=model.device, dtype=model_dtype)
            generation = model.generate(**model_inputs, max_new_tokens=700)
        input_ids = model_inputs.get("input_ids") if hasattr(model_inputs, "get") else None
        if input_ids is not None and hasattr(generation, "ndim") and generation.ndim == 2:
            prompt_token_count = int(input_ids.shape[-1])
            if generation.shape[-1] > prompt_token_count:
                generation = generation[:, prompt_token_count:]
        decoded = "\n".join(
            tokenizer.batch_decode(
                generation,
                skip_special_tokens=True,
                clean_up_tokenization_spaces=False,
            )
        ).strip()
        parsed = extract_json_object(decoded)
        summary = normalize_summary(parsed, decoded, request)
        return {
            "ok": True,
            "profileId": "midashenglm-7b-1021-bf16-local-cuda",
            "modelId": model_id,
            "summary": summary,
            **summary,
        }
    except getattr(torch.cuda, "OutOfMemoryError", RuntimeError) as exc:
        emit_failure(f"MiDashengLM ran out of GPU memory: {exc}", code="audio_understanding_oom", exit_code=3)
    except Exception as exc:
        emit_failure(
            f"MiDashengLM analyzer failed: {type(exc).__name__}: {exc}",
            code="audio_understanding_failed",
            exit_code=4,
        )


def main() -> None:
    parser = argparse.ArgumentParser(description="Run one MiDashengLM analyzer request.")
    parser.add_argument("--request", required=True, help="Path to request JSON.")
    args = parser.parse_args()
    response = run(read_json(Path(args.request)))
    print(json.dumps(response, ensure_ascii=True), flush=True)


if __name__ == "__main__":
    main()
