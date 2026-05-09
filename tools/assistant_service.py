#!/usr/bin/env python3
"""
OpenStudio local assistant one-shot service.

The native app invokes this script with a request JSON file. When a verified
assistant runtime is available it asks Qwen Omni for a strict OpenStudio action
plan. Otherwise it returns a deterministic local plan so the UI and
confirmation flow remain testable before the large model is installed.
"""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import time
from typing import Any


ASSISTANT_STATUS_ENV = "OPENSTUDIO_ASSISTANT_STATUS_FILE"
AUDIO_UNDERSTANDING_STATUS_ENV = "OPENSTUDIO_AUDIO_UNDERSTANDING_STATUS_FILE"
ALLOWED_ACTION_KINDS = {
    "app.executeRegisteredAction",
    "ai.getRuntimeStatus",
    "ai.openSetup",
    "ai.openContextGeneration",
    "ai.createAITrack",
    "ai.setWorkflow",
    "ai.setGenerationParams",
    "ai.generateMusic",
    "ai.cancelGeneration",
    "ai.pollGeneration",
    "ai.insertGeneratedClip",
    "plugin.scan",
    "plugin.listAvailable",
    "plugin.add",
    "plugin.openEditor",
    "plugin.bypass",
    "plugin.remove",
    "plugin.reorder",
    "plugin.listParameters",
    "plugin.loadPreset",
}
PROJECT_ACTION_KINDS = {
    "app.executeRegisteredAction",
    "ai.createAITrack",
    "ai.setWorkflow",
    "ai.setGenerationParams",
    "ai.generateMusic",
    "ai.insertGeneratedClip",
    "plugin.add",
    "plugin.bypass",
    "plugin.remove",
    "plugin.reorder",
    "plugin.loadPreset",
}
UI_ACTION_KINDS = {
    "ai.openSetup",
    "ai.openContextGeneration",
    "ai.cancelGeneration",
    "plugin.scan",
    "plugin.openEditor",
}
ACTION_KIND_ALIASES = {
    "executeRegisteredAction": "app.executeRegisteredAction",
    "runRegisteredAction": "app.executeRegisteredAction",
    "getRuntimeStatus": "ai.getRuntimeStatus",
    "openSetup": "ai.openSetup",
    "openContextGeneration": "ai.openContextGeneration",
    "createAITrack": "ai.createAITrack",
    "setWorkflow": "ai.setWorkflow",
    "setGenerationParams": "ai.setGenerationParams",
    "generateMusic": "ai.generateMusic",
    "cancelGeneration": "ai.cancelGeneration",
    "pollGeneration": "ai.pollGeneration",
    "insertGeneratedClip": "ai.insertGeneratedClip",
    "scanPlugins": "plugin.scan",
    "listPlugins": "plugin.listAvailable",
    "listAvailablePlugins": "plugin.listAvailable",
    "addPlugin": "plugin.add",
    "openPluginEditor": "plugin.openEditor",
    "bypassPlugin": "plugin.bypass",
    "removePlugin": "plugin.remove",
    "reorderPlugin": "plugin.reorder",
    "listPluginParameters": "plugin.listParameters",
    "loadPluginPreset": "plugin.loadPreset",
}


def utc_now_ms() -> int:
    return int(time.time() * 1000)


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def assistant_log_path() -> Path:
    local_app_data = os.environ.get("LOCALAPPDATA", "").strip()
    if local_app_data:
        root = Path(local_app_data) / "OpenStudio" / "logs"
    else:
        root = Path.home() / ".openstudio" / "logs"
    return root / "ai" / "assistant" / f"{datetime.now(timezone.utc).strftime('%Y%m%d')}.jsonl"


def append_assistant_log(event: str, **payload: Any) -> None:
    try:
        path = assistant_log_path()
        path.parent.mkdir(parents=True, exist_ok=True)
        record = {
            "ts": utc_now_iso(),
            "event": event,
            **payload,
        }
        with path.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(record, ensure_ascii=True, default=str) + "\n")
    except Exception:
        pass


def default_status_path() -> Path:
    configured = os.environ.get(ASSISTANT_STATUS_ENV, "").strip()
    if configured:
        return Path(configured).expanduser().resolve()
    return (Path.home() / ".openstudio" / "assistant-runtime-status.json").resolve()


def default_audio_understanding_status_path() -> Path:
    configured = os.environ.get(AUDIO_UNDERSTANDING_STATUS_ENV, "").strip()
    if configured:
        return Path(configured).expanduser().resolve()
    return (Path.home() / ".openstudio" / "audio-understanding-runtime-status.json").resolve()


def read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8-sig"))


def is_record(value: Any) -> bool:
    return isinstance(value, dict)


class AssistantClarificationNeeded(Exception):
    def __init__(self, message: str, missing_context: list[str] | None = None) -> None:
        super().__init__(message)
        self.message = message
        self.missing_context = missing_context or []


class AssistantDirectResponse(Exception):
    def __init__(
        self,
        message: str,
        *,
        mode: str = "answer",
        missing_context: list[str] | None = None,
    ) -> None:
        super().__init__(message)
        self.message = message
        self.mode = mode if mode in {"answer", "clarification"} else "answer"
        self.missing_context = missing_context or []


def is_placeholder_id(value: Any) -> bool:
    raw = str(value or "").strip()
    if not raw:
        return True
    lowered = raw.lower().replace("-", "_")
    return lowered in {
        "selectedclipid",
        "selected_clip_id",
        "clipid",
        "clip_id",
        "selectedtrackid",
        "selected_track_id",
        "trackid",
        "track_id",
        "currenttrackid",
        "current_track_id",
        "selected",
        "selection",
    }


def selected_track_ids(context: dict[str, Any]) -> list[str]:
    value = context.get("selectedTrackIds", [])
    return [str(item) for item in value if str(item).strip()] if isinstance(value, list) else []


def selected_clip_ids(context: dict[str, Any]) -> list[str]:
    value = context.get("selectedClipIds", [])
    return [str(item) for item in value if str(item).strip()] if isinstance(value, list) else []


def find_track(context: dict[str, Any], track_id: str) -> dict[str, Any] | None:
    tracks = context.get("tracks", [])
    if not isinstance(tracks, list):
        return None
    for track in tracks:
        if is_record(track) and str(track.get("id", "")) == track_id:
            return track
    return None


def first_selected_track_id(context: dict[str, Any]) -> str:
    selected = selected_track_ids(context)
    if selected:
        return selected[0]
    tracks = context.get("tracks", [])
    if isinstance(tracks, list) and len(tracks) == 1 and is_record(tracks[0]):
        return str(tracks[0].get("id", "")).strip()
    return ""


def find_clip_context(context: dict[str, Any]) -> dict[str, Any] | None:
    clip_ids = selected_clip_ids(context)
    if not clip_ids:
        return None
    target_clip_id = clip_ids[0]
    tracks = context.get("tracks", [])
    if not isinstance(tracks, list):
        return None
    for track in tracks:
        if not is_record(track):
            continue
        for clip in track.get("clips", []) if isinstance(track.get("clips"), list) else []:
            if is_record(clip) and str(clip.get("id", "")) == target_clip_id:
                return {
                    "trackId": track.get("id", ""),
                    "trackName": track.get("name", ""),
                    "clipId": clip.get("id", ""),
                    "clipName": clip.get("name", ""),
                    "duration": clip.get("duration", 0),
                    "startTime": clip.get("startTime", 0),
                    "filePath": clip.get("filePath", ""),
                }
    return None


def action(
    kind: str,
    params: dict[str, Any] | None = None,
    *,
    risk: str = "read",
    summary: str = "",
) -> dict[str, Any]:
    return {
        "id": f"act_{utc_now_ms()}_{abs(hash((kind, summary))) % 100000}",
        "kind": kind,
        "params": params or {},
        "risk": risk,
        "summary": summary,
    }


def plan(
    *,
    title: str,
    intent: str,
    expected_impact: str,
    actions: list[dict[str, Any]],
    requires_confirmation: bool | None = None,
) -> dict[str, Any]:
    return {
        "id": f"plan_{utc_now_ms()}",
        "title": title,
        "intent": intent,
        "expectedImpact": expected_impact,
        "requiresConfirmation": bool(actions) if requires_confirmation is None else bool(requires_confirmation),
        "actions": actions,
    }


def is_capability_question(prompt: str) -> bool:
    lowered = prompt.lower()
    capability_phrases = (
        "what can you do",
        "what all can you do",
        "what all actions",
        "what actions",
        "what can you perform",
        "what all can you perform",
        "what can you help",
        "what all can you help",
        "how can you help",
        "your capabilities",
        "available actions",
        "supported actions",
        "commands can you",
    )
    return any(phrase in lowered for phrase in capability_phrases)


def capability_response(runtime_ready: bool, context: dict[str, Any]) -> dict[str, Any]:
    action_catalog = context.get("actionCatalog", [])
    plugin_catalog = context.get("pluginCatalog", {})
    action_count = len(action_catalog) if isinstance(action_catalog, list) else 0
    plugin_count = 0
    if isinstance(plugin_catalog, dict):
        for key in ("availablePlugins", "vst", "builtIns", "s13fx"):
            value = plugin_catalog.get(key)
            if isinstance(value, list):
                plugin_count += len(value)
    reply = (
        "I can answer DAW questions, inspect runtime status, prepare confirmed action plans, run OpenStudio "
        "registered actions, create/configure AI music generation tracks, start or stop ACE-Step generation, "
        "insert generated clips, and work with plugin/FX chains when the requested track/plugin context is "
        "available. I can see the current OpenStudio action catalog"
        f"{f' ({action_count} actions)' if action_count else ''}"
        f"{f' and {plugin_count} plugin or FX entries' if plugin_count else ''}. "
        "Every action plan waits for your confirmation before it runs."
    )
    return {
        "ok": True,
        "mode": "answer",
        "reply": reply,
        "runtimeReady": runtime_ready,
        "modelUsed": False,
        "fallbackUsed": False,
        "informational": True,
        "audioUnderstandingUsed": False,
        "audioUnderstandingStatus": "not_installed",
    }


def text_from_recent_context(context: dict[str, Any]) -> str:
    parts: list[str] = []
    recent = context.get("recentConversation", [])
    if isinstance(recent, list):
        for item in recent[-8:]:
            if is_record(item):
                parts.append(str(item.get("text", "")))
    last_result = context.get("lastExecutionResult")
    if is_record(last_result):
        parts.append(str(last_result.get("summary", "")))
        steps = last_result.get("steps", [])
        if isinstance(steps, list):
            for step in steps[-4:]:
                if is_record(step):
                    parts.append(str(step.get("summary", "")))
                    parts.append(str(step.get("kind", "")))
    return "\n".join(parts).lower()


def is_audio_understanding_status_question(prompt: str, context: dict[str, Any]) -> bool:
    lowered = prompt.lower()
    if is_direct_audio_analysis_request(prompt):
        return False
    direct_terms = (
        "music analyzer",
        "audio analyzer",
        "audio understanding",
        "midashenglm",
        "midasheng",
        "salmonn",
        "analyzer ready",
        "analyser ready",
        "analyzer installed",
        "analyser installed",
    )
    if any(term in lowered for term in direct_terms):
        return any(word in lowered for word in ("ready", "installed", "there", "status", "working", "available", "is "))
    if lowered.strip() in {"so is it there?", "so is it there", "is it there?", "is it there", "is it ready?", "is it ready"}:
        recent_text = text_from_recent_context(context)
        return any(term in recent_text for term in ("music analyzer", "audio understanding", "midashenglm", "midasheng", "salmonn"))
    return False


def is_audio_understanding_license_question(prompt: str, context: dict[str, Any]) -> bool:
    lowered = prompt.lower()
    license_terms = ("license", "licence", "terms", "pay", "paid", "payment", "cost", "fee", "commercial")
    analyzer_terms = ("music analyzer", "audio analyzer", "audio understanding", "midashenglm", "midasheng", "analyzer", "analyser")
    if not any(term in lowered for term in license_terms):
        return False
    if any(term in lowered for term in analyzer_terms):
        return True
    recent_text = text_from_recent_context(context)
    return any(term in recent_text for term in analyzer_terms)


def is_runtime_status_question(prompt: str) -> bool:
    lowered = prompt.lower()
    if any(term in lowered for term in ("music analyzer", "audio understanding", "midashenglm", "midasheng", "salmonn")):
        return False
    status_words = ("ready", "verified", "installed", "status", "working", "runtime")
    runtime_terms = ("qwen", "assistant", "ace", "ace-step", "stem", "ai tools")
    return any(term in lowered for term in runtime_terms) and any(word in lowered for word in status_words)


def is_setup_request(prompt: str) -> bool:
    lowered = prompt.lower()
    direct_phrases = (
        "open setup",
        "open ai tools",
        "ai tools setup",
        "download and install",
        "download install",
        "run setup",
        "start setup",
        "install ai tools",
        "setup ai tools",
        "verify assistant",
        "verify qwen",
        "verify runtime",
    )
    if any(phrase in lowered for phrase in direct_phrases):
        return True
    setup_verbs = ("install", "download", "setup", "set up", "verify", "configure")
    setup_targets = (
        "qwen",
        "assistant runtime",
        "local runtime",
        "ai runtime",
        "ai tools",
        "music analyzer",
        "core analyzer",
        "core music analyzer",
        "audio analyzer",
    )
    return any(verb in lowered for verb in setup_verbs) and any(target in lowered for target in setup_targets)


def is_plugin_inventory_question(prompt: str) -> bool:
    lowered = prompt.lower()
    plugin_terms = ("plugin", "plugins", "fx", "effects", "vst", "vst3", "s13fx", "built-in", "builtin")
    inventory_terms = (
        "what",
        "which",
        "list",
        "available",
        "present",
        "currently",
        "can i use",
        "installed",
        "do i have",
    )
    return any(term in lowered for term in plugin_terms) and any(term in lowered for term in inventory_terms)


def _format_catalog_items(items: Any, *, label_key: str = "name", detail_keys: tuple[str, ...] = (), limit: int = 12) -> list[str]:
    if not isinstance(items, list):
        return []
    formatted: list[str] = []
    for item in items[:limit]:
        if not is_record(item):
            continue
        label = str(item.get(label_key) or item.get("fileOrIdentifier") or "").strip()
        if not label:
            continue
        details = [str(item.get(key) or "").strip() for key in detail_keys]
        detail = ", ".join(value for value in details if value)
        formatted.append(f"{label}{f' ({detail})' if detail else ''}")
    return formatted


def describe_plugin_catalog(context: dict[str, Any]) -> tuple[str, dict[str, Any]]:
    plugin_catalog = context.get("pluginCatalog", {})
    if not is_record(plugin_catalog):
        return (
            "I cannot see a plugin catalog yet. Try scanning plugins or opening the plugin browser first.",
            {"total": 0},
        )

    vst_items = plugin_catalog.get("availablePlugins", [])
    built_ins = plugin_catalog.get("builtIns", [])
    s13fx = plugin_catalog.get("s13fx", [])
    vst_count = len(vst_items) if isinstance(vst_items, list) else 0
    built_in_count = len(built_ins) if isinstance(built_ins, list) else 0
    s13fx_count = len(s13fx) if isinstance(s13fx, list) else 0
    total = vst_count + built_in_count + s13fx_count

    if total == 0:
        return (
            "I do not see any available plugin or FX entries in the current catalog. Run a plugin scan if you expected VST/CLAP/LV2 plugins.",
            {"total": 0, "vst": 0, "builtIns": 0, "s13fx": 0},
        )

    sections: list[str] = [f"I can see {total} plugin/FX entries right now."]
    built_in_list = _format_catalog_items(built_ins, detail_keys=("category",), limit=10)
    if built_in_count:
        sections.append(
            f"Built-in FX ({built_in_count}): "
            + (", ".join(built_in_list) + ("..." if built_in_count > len(built_in_list) else ""))
        )
    s13fx_list = _format_catalog_items(s13fx, detail_keys=("author",), limit=10)
    if s13fx_count:
        sections.append(
            f"S13FX scripts ({s13fx_count}): "
            + (", ".join(s13fx_list) + ("..." if s13fx_count > len(s13fx_list) else ""))
        )
    vst_list = _format_catalog_items(vst_items, detail_keys=("pluginFormatName", "manufacturer"), limit=12)
    if vst_count:
        sections.append(
            f"Scanned plugins ({vst_count}): "
            + (", ".join(vst_list) + ("..." if vst_count > len(vst_list) else ""))
        )
    sections.append("Ask me to add one by name to a selected track, input FX chain, or the master chain.")
    return "\n".join(sections), {
        "total": total,
        "vst": vst_count,
        "builtIns": built_in_count,
        "s13fx": s13fx_count,
    }


def describe_audio_understanding_status(context: dict[str, Any]) -> tuple[str, dict[str, Any]]:
    ai_tools = context.get("aiToolsStatus", {})
    if not is_record(ai_tools):
        ai_tools = {}
    status = str(ai_tools.get("audioUnderstandingStatus") or "not_installed").strip() or "not_installed"
    selected = str(
        ai_tools.get("audioUnderstandingSelectedProfile")
        or ai_tools.get("audioUnderstandingPrefilterProfile")
        or ""
    ).strip()
    message = str(ai_tools.get("audioUnderstandingStatusMessage") or "").strip()
    profiles = ai_tools.get("audioUnderstandingRuntimeProfiles")
    candidate_label = ""
    if is_record(profiles):
        profile = profiles.get(selected) if selected else None
        if not is_record(profile):
            for value in profiles.values():
                if is_record(value):
                    profile = value
                    break
        if is_record(profile):
            candidate_label = str(profile.get("label") or profile.get("profileId") or "").strip()

    status_label = status.replace("_", " ")
    if status == "ready":
        reply = f"Yes. The core music analyzer is ready{f' with {candidate_label}' if candidate_label else ''}."
    elif status == "license_blocked":
        reply = (
            "No. The configured core music analyzer is blocked by its runtime policy. "
            "The default MiDashengLM analyzer does not require license acceptance."
        )
    elif status == "not_installed":
        reply = "No. The core music analyzer is not installed, so OpenStudio cannot hear selected audio yet."
    elif status == "unsupported":
        reply = "No. The core music analyzer is unsupported on this machine/runtime right now."
    elif status == "oom":
        reply = "No. The core music analyzer failed its smoke test because it ran out of GPU memory."
    elif status == "installing":
        reply = "The core music analyzer install is still in progress."
    else:
        reply = f"No. The core music analyzer status is {status_label}."
    if selected or candidate_label:
        reply += f" Candidate: {candidate_label or selected}."
    if message:
        reply += f" Detail: {message}"
    return reply, {"audioUnderstandingStatus": status, "audioUnderstandingProfile": selected, "audioUnderstandingMessage": message}


def describe_audio_understanding_license(context: dict[str, Any]) -> tuple[str, dict[str, Any]]:
    ai_tools = context.get("aiToolsStatus", {})
    if not is_record(ai_tools):
        ai_tools = {}
    profiles = ai_tools.get("audioUnderstandingRuntimeProfiles")
    profile: dict[str, Any] = {}
    if is_record(profiles):
        selected = str(
            ai_tools.get("audioUnderstandingSelectedProfile")
            or ai_tools.get("audioUnderstandingPrefilterProfile")
            or ""
        ).strip()
        if selected and is_record(profiles.get(selected)):
            profile = dict(profiles[selected])
        else:
            for value in profiles.values():
                if is_record(value):
                    profile = dict(value)
                    break

    model_repo = str(profile.get("modelRepo") or "mispeech/midashenglm-7b-1021-bf16").strip()
    label = str(profile.get("label") or "MiDashengLM 7B 1021 BF16 Local CUDA").strip()
    license_value = str(profile.get("license") or "apache-2.0").strip()
    requires_acceptance = bool(profile.get("requiresLicenseAcceptance", False))
    status = str(ai_tools.get("audioUnderstandingStatus") or "not_installed").strip() or "not_installed"

    reply = (
        f"The core music analyzer is {label} ({model_repo}). Its configured license is {license_value}. "
        "MiDashengLM is the default analyzer profile for OpenStudio because it is Apache-2.0 and does not "
        "require separate model-license acceptance in this manifest. It provides semantic music/audio "
        "understanding for selected clips; Qwen uses that analyzer output to plan OpenStudio actions."
    )
    if requires_acceptance:
        reply += " The app blocks automatic install until that license acceptance is recorded."
    return (
        reply,
        {
            "audioUnderstandingStatus": status,
            "audioUnderstandingProfile": str(profile.get("profileId") or ""),
            "audioUnderstandingModelRepo": model_repo,
            "audioUnderstandingLicense": license_value,
            "requiresLicenseAcceptance": requires_acceptance,
        },
    )


def describe_audio_analysis_blocker(
    context: dict[str, Any],
    clip_context: dict[str, Any],
) -> tuple[str, dict[str, Any]]:
    ai_tools = context.get("aiToolsStatus", {})
    if not is_record(ai_tools):
        ai_tools = {}
    status = str(ai_tools.get("audioUnderstandingStatus") or "not_installed").strip() or "not_installed"
    message = str(ai_tools.get("audioUnderstandingStatusMessage") or "").strip()
    profile = str(
        ai_tools.get("audioUnderstandingSelectedProfile")
        or ai_tools.get("audioUnderstandingPrefilterProfile")
        or ""
    ).strip()
    clip_name = str(clip_context.get("clipName") or "the selected clip").strip()

    if status == "license_blocked":
        reason = "the configured analyzer profile is blocked by license acceptance"
    elif status == "oom":
        reason = "the core music analyzer failed because it ran out of GPU memory"
    elif status == "unsupported":
        reason = "no compatible core music-analyzer profile passed the hardware/runtime check"
    elif status == "not_installed":
        reason = "the core music analyzer is not installed"
    else:
        reason = f"the core music analyzer status is {status.replace('_', ' ')}"

    reply = (
        f"OpenStudio cannot truthfully analyze the sound of {clip_name} yet because {reason}. "
        "Without that analyzer summary, Qwen only sees project metadata such as track names, clips, plugins, "
        "tempo, and selection state; it does not actually hear the audio. "
        "I can still help with plugin choices, routing, editing steps, or AI generation plans."
    )
    if profile:
        reply += f" Candidate/profile: {profile}."
    if message:
        reply += f" Detail: {message}"
    return (
        reply,
        {
            "audioUnderstandingStatus": status,
            "audioUnderstandingProfile": profile,
            "audioUnderstandingMessage": message,
            "clipId": str(clip_context.get("clipId") or ""),
        },
    )


def describe_runtime_status(runtime_ready: bool, context: dict[str, Any]) -> tuple[str, dict[str, Any]]:
    ai_tools = context.get("aiToolsStatus", {})
    if not is_record(ai_tools):
        ai_tools = {}
    assistant_ready = bool(ai_tools.get("assistantRuntimeReady", runtime_ready))
    music_status = str(
        ai_tools.get("musicGenerationStatusMessage")
        or ("ACE-Step music generation is ready." if ai_tools.get("musicGenerationReady") else "")
    ).strip()
    backend = str(ai_tools.get("selectedBackend") or "").strip()
    parts = [
        f"Qwen planner is {'verified' if assistant_ready else 'not verified'}.",
        f"ACE-Step music generation is {'ready' if ai_tools.get('musicGenerationReady') else 'not ready'}."
    ]
    if backend:
        parts.append(f"Active backend: {backend}.")
    if music_status:
        parts.append(music_status)
    return " ".join(parts), {"assistantRuntimeReady": assistant_ready, "musicGenerationReady": bool(ai_tools.get("musicGenerationReady"))}


def fallback_plan(prompt: str, context: dict[str, Any], runtime_ready: bool) -> tuple[str, dict[str, Any]]:
    lowered = prompt.lower()
    selected_track = selected_track_ids(context)[0] if selected_track_ids(context) else ""
    clip_context = find_clip_context(context)

    if not runtime_ready and is_setup_request(prompt):
        assistant_plan = plan(
            title="Install the local Qwen assistant runtime",
            intent="Prepare the verified local assistant model before running DAW actions.",
            expected_impact="Opens AI Tools Setup. No project data is changed.",
            actions=[
                action("ai.getRuntimeStatus", risk="read", summary="Check AI runtime status."),
                action("ai.openSetup", risk="ui", summary="Open AI Tools Setup."),
            ],
        )
        return (
            "The Qwen assistant runtime is not verified yet. Open AI Tools Setup and run Download and Install first.",
            assistant_plan,
        )
    if not runtime_ready:
        assistant_plan = plan(
            title="Check assistant runtime status",
            intent="Inspect the local AI tools and assistant runtime state.",
            expected_impact="Reads runtime status only. No project data is changed.",
            actions=[
                action("ai.getRuntimeStatus", risk="read", summary="Check the local assistant runtime."),
            ],
        )
        return (
            "The local Qwen planner is not verified yet. I can check runtime status, but I will not open setup unless you ask for setup or installation.",
            assistant_plan,
        )

    if clip_context and any(word in lowered for word in ("clip", "context", "reference", "remix", "cover", "repaint", "edit")):
        assistant_plan = plan(
            title="Open ACE context generation for the selected clip",
            intent="Use the selected audio clip as context for ACE-Step generation.",
            expected_impact="Opens the context generation modal for review. No clip is generated until you press Generate.",
            actions=[
                action(
                    "ai.openContextGeneration",
                    {
                        "trackId": clip_context["trackId"],
                        "clipId": clip_context["clipId"],
                    },
                    risk="ui",
                    summary=f"Open context generation for {clip_context.get('clipName') or 'selected clip'}.",
                )
            ],
        )
        return ("I can open ACE context generation for the selected clip.", assistant_plan)

    wants_music = any(
        word in lowered
        for word in ("generate", "create", "make", "compose", "music", "beat", "song", "instrumental", "lyrics")
    )
    if wants_music:
        workflow_id = "lyrics-style" if "lyric" in lowered or "vocal" in lowered else "text-to-music"
        track_name = "AI Lyrics" if workflow_id == "lyrics-style" else "AI Music"
        generation_params: dict[str, Any] = {
            "prompt": prompt.strip(),
        }
        if "instrumental" in lowered or "without lyrics" in lowered:
            generation_params["lyrics"] = ""

        create_params: dict[str, Any] = {
            "trackName": track_name,
            "workflowId": workflow_id,
            "params": generation_params,
        }
        if selected_track:
            create_params["insertAfterTrackId"] = selected_track

        assistant_plan = plan(
            title="Create an AI music generation track",
            intent="Set up an ACE-Step generation request from your prompt.",
            expected_impact="Adds a new AI track and starts generation after confirmation.",
            actions=[
                action(
                    "ai.createAITrack",
                    create_params,
                    risk="project",
                    summary="Create a configured AI generation track.",
                )
            ],
        )
        return ("I prepared an ACE-Step generation plan for your prompt.", assistant_plan)

    assistant_plan = plan(
        title="Check assistant runtime status",
        intent="Inspect the local AI tools and assistant runtime state.",
        expected_impact="Reads runtime status only. No project data is changed.",
        actions=[
            action("ai.getRuntimeStatus", risk="read", summary="Check the local assistant runtime."),
        ],
    )
    return ("I can check the assistant runtime status first.", assistant_plan)


def extract_json_object(text: str) -> dict[str, Any]:
    stripped = text.strip()
    candidates = [stripped]
    if "```" in stripped:
        parts = stripped.replace("```json", "```").split("```")
        if len(parts) >= 3:
            candidates.insert(0, parts[1].strip())

    decoder = json.JSONDecoder()
    last_error: json.JSONDecodeError | None = None
    for candidate in candidates:
        start = candidate.find("{")
        while start >= 0:
            try:
                value, _ = decoder.raw_decode(candidate[start:])
            except json.JSONDecodeError as exc:
                last_error = exc
                start = candidate.find("{", start + 1)
                continue
            if not isinstance(value, dict):
                raise ValueError("assistant response JSON root must be an object")
            return value

    if last_error is not None:
        raise last_error
    raise ValueError("assistant response did not contain a JSON object")


def normalize_action_kind(value: Any) -> str:
    raw = str(value or "").strip()
    if raw in ALLOWED_ACTION_KINDS:
        return raw
    if raw in ACTION_KIND_ALIASES:
        return ACTION_KIND_ALIASES[raw]
    if raw.startswith("ai.") and raw in ALLOWED_ACTION_KINDS:
        return raw
    return ""


def infer_action_risk(kind: str, provided: Any) -> str:
    raw = str(provided or "").strip()
    if raw in {"read", "ui", "project"}:
        return raw
    if kind in PROJECT_ACTION_KINDS:
        return "project"
    if kind in UI_ACTION_KINDS:
        return "ui"
    return "read"


def context_action_ids(context: dict[str, Any]) -> set[str]:
    catalog = context.get("actionCatalog", [])
    ids: set[str] = set()
    if isinstance(catalog, list):
        for item in catalog:
            if is_record(item):
                action_id = str(item.get("id", "")).strip()
                if action_id:
                    ids.add(action_id)
    return ids


def repair_track_param(
    params: dict[str, Any],
    context: dict[str, Any],
    *,
    missing_context: list[str],
    reason: str = "Select a track first.",
) -> None:
    track_id = str(params.get("trackId", "")).strip()
    if track_id and not is_placeholder_id(track_id):
        return
    selected = first_selected_track_id(context)
    if selected:
        params["trackId"] = selected
        return
    missing_context.append(reason)


def normalize_target(params: dict[str, Any]) -> None:
    target = str(params.get("target") or "").strip().lower()
    if target not in {"track", "master"}:
        target = "track"
    params["target"] = target


def repair_and_validate_action_params(
    kind: str,
    params: dict[str, Any],
    context: dict[str, Any],
) -> tuple[dict[str, Any], list[str]]:
    repaired = dict(params)
    missing_context: list[str] = []

    if kind == "app.executeRegisteredAction":
        action_id = str(repaired.get("actionId", "")).strip()
        if not action_id:
            missing_context.append("Choose an OpenStudio action to run.")
        known_actions = context_action_ids(context)
        if known_actions and action_id and action_id not in known_actions:
            missing_context.append(f"Unknown OpenStudio action id: {action_id}.")

    elif kind == "ai.openContextGeneration":
        clip_context = find_clip_context(context)
        clip_id = str(repaired.get("clipId", "")).strip()
        track_id = str(repaired.get("trackId", "")).strip()
        if clip_context and (is_placeholder_id(clip_id) or is_placeholder_id(track_id)):
            repaired["trackId"] = clip_context["trackId"]
            repaired["clipId"] = clip_context["clipId"]
        elif is_placeholder_id(clip_id) or is_placeholder_id(track_id):
            missing_context.append("Select one audio clip first.")

    elif kind in {"ai.setWorkflow", "ai.setGenerationParams", "ai.generateMusic", "ai.cancelGeneration", "ai.pollGeneration"}:
        if kind in {"ai.cancelGeneration", "ai.pollGeneration"} and not str(repaired.get("trackId", "")).strip():
            return repaired, missing_context
        repair_track_param(repaired, context, missing_context=missing_context)

    elif kind == "ai.insertGeneratedClip":
        repair_track_param(repaired, context, missing_context=missing_context)
        if not str(repaired.get("filePath", "")).strip():
            missing_context.append("Choose the generated audio file to insert.")

    elif kind == "plugin.add":
        normalize_target(repaired)
        if repaired["target"] == "track":
            repair_track_param(repaired, context, missing_context=missing_context)
        if not str(repaired.get("pluginId", "")).strip():
            missing_context.append("Choose a plugin or built-in FX to add.")

    elif kind in {"plugin.openEditor", "plugin.bypass", "plugin.remove", "plugin.listParameters"}:
        normalize_target(repaired)
        if repaired["target"] == "track":
            repair_track_param(repaired, context, missing_context=missing_context)
        fx_index = repaired.get("fxIndex")
        if not isinstance(fx_index, int) or fx_index < 0:
            missing_context.append("Choose an FX slot first.")
        if kind == "plugin.bypass" and not isinstance(repaired.get("bypassed"), bool):
            repaired["bypassed"] = True

    elif kind in {"plugin.reorder", "plugin.loadPreset"}:
        repair_track_param(repaired, context, missing_context=missing_context)
        if kind == "plugin.reorder":
            if not isinstance(repaired.get("fromIndex"), int) or not isinstance(repaired.get("toIndex"), int):
                missing_context.append("Choose source and destination FX slots.")
        if kind == "plugin.loadPreset" and not str(repaired.get("presetName", "")).strip():
            missing_context.append("Choose a preset name.")

    return repaired, missing_context


def validate_assistant_plan(value: dict[str, Any], context: dict[str, Any] | None = None) -> dict[str, Any]:
    context = context or {}
    if isinstance(value.get("plan"), dict):
        value = value["plan"]
    elif isinstance(value.get("actionPlan"), dict):
        value = value["actionPlan"]

    raw_actions = value.get("actions")
    if not isinstance(raw_actions, list) or not raw_actions:
        raise ValueError("assistant response JSON did not match the OpenStudio action-plan schema")

    normalized_actions: list[dict[str, Any]] = []
    for index, item in enumerate(raw_actions):
        if not isinstance(item, dict):
            raise ValueError("assistant action entry must be an object")
        kind = normalize_action_kind(item.get("kind") or item.get("type") or item.get("action"))
        if kind not in ALLOWED_ACTION_KINDS:
            raise ValueError(f"assistant action entry has unsupported kind: {item.get('kind')}")
        params = item.get("params")
        if not isinstance(params, dict):
            params = {}
        params, missing_context = repair_and_validate_action_params(kind, params, context)
        if missing_context:
            raise AssistantClarificationNeeded(
                "I need more context before I can safely run that action.",
                missing_context,
            )
        summary = str(item.get("summary") or item.get("description") or kind).strip()
        risk = infer_action_risk(kind, item.get("risk"))
        action_id = str(item.get("id") or "").strip() or f"act_{utc_now_ms()}_{index}"
        normalized_actions.append(
            {
                "id": action_id,
                "kind": kind,
                "params": params,
                "risk": risk,
                "summary": summary,
            }
        )

    title = str(value.get("title") or value.get("name") or "OpenStudio assistant action plan").strip()
    intent = str(value.get("intent") or value.get("description") or title).strip()
    expected_impact = str(
        value.get("expectedImpact")
        or value.get("impact")
        or value.get("expected_impact")
        or "Runs the listed OpenStudio actions."
    ).strip()
    requires_confirmation = bool(normalized_actions)

    return {
        "id": str(value.get("id") or f"plan_{utc_now_ms()}").strip(),
        "title": title,
        "intent": intent,
        "expectedImpact": expected_impact,
        "requiresConfirmation": requires_confirmation,
        "actions": normalized_actions,
    }


def wants_audio_understanding(prompt: str) -> bool:
    lowered = prompt.lower()
    return any(
        word in lowered
        for word in (
            "analyze",
            "describe",
            "identify",
            "what is in",
            "what's in",
            "genre",
            "instrument",
            "vocal",
            "tempo",
            "bpm",
            "key",
            "mood",
            "arrangement",
            "production",
            "reference",
            "similar",
            "clip",
            "audio",
            "song",
            "mix",
        )
    )


def is_direct_audio_analysis_request(prompt: str) -> bool:
    lowered = prompt.lower()
    request_phrases = (
        "analyze this",
        "analyse this",
        "analyze the",
        "analyse the",
        "listen to",
        "hear this",
        "hear the",
        "tell me what i can",
        "what can i do",
        "make it sound better",
        "sound better",
        "mix feedback",
        "production feedback",
        "describe this track",
        "describe the track",
        "describe this clip",
        "describe the clip",
    )
    subject_terms = ("track", "clip", "audio", "song", "mix", "vocal", "instrumental", "project")
    return any(phrase in lowered for phrase in request_phrases) and any(term in lowered for term in subject_terms)


def load_optional_status(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {}
    try:
        loaded = read_json(path)
    except Exception:
        return {}
    return loaded if isinstance(loaded, dict) else {}


def compact_audio_understanding_summary(value: dict[str, Any], profile_id: str) -> dict[str, Any]:
    source = value.get("summary") if isinstance(value.get("summary"), dict) else value
    allowed_fields = (
        "genre",
        "tempoFeel",
        "bpm",
        "keyGuess",
        "instruments",
        "vocals",
        "arrangement",
        "mood",
        "productionNotes",
        "mixIssues",
        "suggestedDawActions",
        "promptReadySummary",
        "confidence",
        "inferenceNotice",
    )
    summary: dict[str, Any] = {"profileId": profile_id}
    for field in allowed_fields:
        item = source.get(field) if isinstance(source, dict) else None
        if isinstance(item, (str, int, float, bool)) or (
            isinstance(item, list)
            and all(isinstance(entry, (str, int, float, bool)) for entry in item[:16])
        ):
            summary[field] = item
    return summary


def describe_audio_understanding_summary(summary: dict[str, Any], clip_context: dict[str, Any]) -> str:
    clip_name = str(clip_context.get("clipName") or "the selected clip").strip()
    parts: list[str] = [f"OpenStudio analyzed {clip_name} with the core music analyzer."]
    prompt_ready = str(summary.get("promptReadySummary") or "").strip()
    if prompt_ready:
        parts.append(prompt_ready)
    descriptors: list[str] = []
    for label, key in (
        ("Genre", "genre"),
        ("Tempo feel", "tempoFeel"),
        ("Key guess", "keyGuess"),
        ("Vocals", "vocals"),
        ("Arrangement", "arrangement"),
        ("Mood", "mood"),
    ):
        value = summary.get(key)
        if isinstance(value, str) and value.strip():
            descriptors.append(f"{label}: {value.strip()}")
    instruments = summary.get("instruments")
    if isinstance(instruments, list) and instruments:
        descriptors.append("Instruments: " + ", ".join(str(item) for item in instruments[:8]))
    mix_issues = summary.get("mixIssues")
    if isinstance(mix_issues, list) and mix_issues:
        descriptors.append("Mix issues: " + "; ".join(str(item) for item in mix_issues[:5]))
    suggested_actions = summary.get("suggestedDawActions")
    if isinstance(suggested_actions, list) and suggested_actions:
        descriptors.append("Suggested DAW actions: " + "; ".join(str(item) for item in suggested_actions[:5]))
    production_notes = str(summary.get("productionNotes") or "").strip()
    if production_notes:
        descriptors.append("Production notes: " + production_notes)
    if descriptors:
        parts.append("\n".join(descriptors))
    inference_notice = str(summary.get("inferenceNotice") or "").strip()
    if inference_notice:
        parts.append(inference_notice)
    return "\n\n".join(parts)


def call_audio_understanding_analyzer(
    prompt: str,
    clip_context: dict[str, Any],
    status: dict[str, Any],
) -> dict[str, Any]:
    profile_id = str(status.get("profileId", "")).strip()
    verification = status.get("verification", {})
    if not isinstance(verification, dict):
        verification = {}

    runtime_path = str(status.get("runtimePath") or verification.get("runtimePath") or sys.executable).strip()
    service_script = str(status.get("serviceScript") or verification.get("serviceScript") or "").strip()
    if not service_script:
        raise RuntimeError("verified analyzer status does not include serviceScript")
    service_path = Path(service_script).expanduser()
    if not service_path.is_absolute():
        candidates = [
            Path(__file__).resolve().with_name(service_script),
            Path.cwd() / service_script,
            Path.cwd() / "scripts" / service_script,
        ]
        service_path = next((candidate for candidate in candidates if candidate.exists()), candidates[0])

    clip_path = str(clip_context.get("filePath", "")).strip()
    if not clip_path:
        raise RuntimeError("selected clip does not include an audio file path")
    if not Path(clip_path).expanduser().exists():
        raise RuntimeError("selected clip audio file was not found")

    request = {
        "schemaVersion": 1,
        "prompt": prompt,
        "modelPath": status.get("modelPath") or verification.get("modelPath") or status.get("modelRepo", ""),
        "clip": clip_context,
        "outputSchema": {
            "genre": "string",
            "tempoFeel": "string",
            "bpm": "number|null",
            "keyGuess": "string",
            "instruments": "string[]",
            "vocals": "string",
            "arrangement": "string",
            "mood": "string",
            "productionNotes": "string",
            "mixIssues": "string[]",
            "suggestedDawActions": "string[]",
            "promptReadySummary": "string",
            "confidence": "number|null",
        },
    }

    request_path = ""
    try:
        with tempfile.NamedTemporaryFile("w", encoding="utf-8", suffix=".json", delete=False) as handle:
            json.dump(request, handle, ensure_ascii=True)
            request_path = handle.name

        result = subprocess.run(
            [runtime_path, str(service_path), "--request", request_path],
            text=True,
            capture_output=True,
            timeout=180,
            check=False,
        )
        output = (result.stdout or "") + "\n" + (result.stderr or "")
        if result.returncode != 0:
            raise RuntimeError(f"analyzer exited with {result.returncode}: {output.strip()[:600]}")
        parsed = extract_json_object(output)
        return compact_audio_understanding_summary(parsed, profile_id)
    finally:
        if request_path:
            try:
                Path(request_path).unlink(missing_ok=True)
            except Exception:
                pass


def build_model_prompt(user_prompt: str, context: dict[str, Any]) -> str:
    compact_context = {
        "tempo": context.get("tempo"),
        "timeSignature": context.get("timeSignature"),
        "currentTime": context.get("currentTime"),
        "selectedTrackIds": context.get("selectedTrackIds", []),
        "selectedClipIds": context.get("selectedClipIds", []),
        "tracks": context.get("tracks", [])[:24] if isinstance(context.get("tracks"), list) else [],
        "aiToolsStatus": context.get("aiToolsStatus", {}),
        "actionCatalog": context.get("actionCatalog", [])[:160] if isinstance(context.get("actionCatalog"), list) else [],
        "pluginCatalog": context.get("pluginCatalog", {}),
        "currentFxChains": context.get("currentFxChains", {}),
        "recentConversation": context.get("recentConversation", [])[-8:]
        if isinstance(context.get("recentConversation"), list)
        else [],
        "lastExecutionResult": context.get("lastExecutionResult", {}),
    }
    audio_summary = context.get("audioUnderstandingSummary")
    if isinstance(audio_summary, dict):
        compact_context["audioUnderstandingSummary"] = audio_summary
    return (
        "You are OpenStudio's local DAW assistant. For direct questions, prefer an answer object. "
        "For any action, return a plan object. Return only strict JSON matching one of these shapes:\n"
        "{mode:'answer'|'clarification',reply:string,missingContext?:string[]} OR\n"
        "{id:string,title:string,intent:string,expectedImpact:string,requiresConfirmation:boolean,"
        "actions:Array<{id:string,kind:string,risk:'read'|'ui'|'project',params:object,summary?:string}>}.\n"
        "Allowed action kinds: app.executeRegisteredAction, ai.getRuntimeStatus, ai.openSetup, "
        "ai.openContextGeneration, ai.createAITrack, ai.setWorkflow, ai.setGenerationParams, "
        "ai.generateMusic, ai.cancelGeneration, ai.pollGeneration, ai.insertGeneratedClip, "
        "plugin.scan, plugin.listAvailable, plugin.add, plugin.openEditor, plugin.bypass, "
        "plugin.remove, plugin.reorder, plugin.listParameters, plugin.loadPreset.\n"
        "Every action plan must set requiresConfirmation to true.\n"
        "Use ai.openContextGeneration when a selected clip should be used as audio context.\n"
        "Use app.executeRegisteredAction only with an id present in actionCatalog.\n"
        "Use plugin actions only with track/plugin/fx ids present in the context. If the user has not selected "
        "the needed track, clip, plugin, or FX slot, return mode clarification instead of placeholder ids.\n"
        "When audioUnderstandingSummary is present, treat it as core analyzer evidence about the selected clip.\n"
        "Use ACE actions through OpenStudio only; never mention running Python scripts directly.\n\n"
        f"Project context JSON:\n{json.dumps(compact_context, ensure_ascii=True)}\n\n"
        f"User request:\n{user_prompt}\n"
    )


def call_qwen_plan(prompt: str, context: dict[str, Any], status: dict[str, Any]) -> tuple[str, dict[str, Any], str]:
    model_path = str(status.get("modelPath", "")).strip()
    if not model_path:
        verification = status.get("verification", {})
        if isinstance(verification, dict):
            model_path = str(verification.get("modelPath", "")).strip()
    if not model_path:
        raise RuntimeError("verified assistant status does not include modelPath")

    from transformers import Qwen2_5OmniForConditionalGeneration, Qwen2_5OmniProcessor
    import torch

    model_kwargs: dict[str, Any] = {
        "device_map": "auto",
        "torch_dtype": torch.bfloat16 if torch.cuda.is_available() else "auto",
        "enable_audio_output": False,
    }
    attention_backend = str(status.get("verification", {}).get("attentionBackend", "")).strip()
    if attention_backend:
        model_kwargs["attn_implementation"] = attention_backend

    model = Qwen2_5OmniForConditionalGeneration.from_pretrained(model_path, **model_kwargs)
    processor = Qwen2_5OmniProcessor.from_pretrained(model_path)
    conversation = [
        {
            "role": "system",
            "content": [
                {
                    "type": "text",
                    "text": "You produce strict JSON OpenStudio assistant responses and no prose.",
                }
            ],
        },
        {
            "role": "user",
            "content": [{"type": "text", "text": build_model_prompt(prompt, context)}],
        },
    ]
    inputs = processor.apply_chat_template(
        conversation,
        add_generation_prompt=True,
        tokenize=True,
        return_dict=True,
        return_tensors="pt",
        padding=True,
        use_audio_in_video=False,
    )
    target_device = getattr(getattr(model, "thinker", model), "device", getattr(model, "device", None))
    if target_device is not None:
        inputs = inputs.to(target_device)
    generated = model.generate(
        **inputs,
        use_audio_in_video=False,
        return_audio=False,
        thinker_max_new_tokens=512,
    )
    if isinstance(generated, tuple):
        generated = generated[0]
    input_ids = inputs.get("input_ids") if hasattr(inputs, "get") else None
    if input_ids is not None and hasattr(generated, "ndim") and generated.ndim == 2:
        prompt_token_count = int(input_ids.shape[-1])
        if generated.shape[-1] > prompt_token_count:
            generated = generated[:, prompt_token_count:]
    raw_text = "\n".join(
        processor.batch_decode(generated, skip_special_tokens=True, clean_up_tokenization_spaces=False)
    ).strip()
    try:
        parsed_raw = extract_json_object(raw_text)
        parsed_mode = str(parsed_raw.get("mode", "")).strip()
        if parsed_mode in {"answer", "clarification"}:
            missing_context = (
                [str(item) for item in parsed_raw.get("missingContext", []) if str(item).strip()]
                if isinstance(parsed_raw.get("missingContext"), list)
                else []
            )
            raise AssistantDirectResponse(
                str(parsed_raw.get("reply") or "I need a little more context before I can safely do that."),
                mode=parsed_mode,
                missing_context=missing_context,
            )
        parsed = validate_assistant_plan(parsed_raw, context)
    except Exception as exc:
        append_assistant_log(
            "model_plan_invalid",
            error=f"{type(exc).__name__}: {exc}",
            rawText=raw_text[:4000],
        )
        raise
    append_assistant_log(
        "model_plan_succeeded",
        title=str(parsed.get("title", "")),
        actionCount=len(parsed.get("actions", [])) if isinstance(parsed.get("actions"), list) else 0,
        rawText=raw_text[:2000],
    )
    reply = str(parsed.get("title") or "Assistant plan ready.")
    return reply, parsed, raw_text


def run(request: dict[str, Any]) -> dict[str, Any]:
    prompt = str(request.get("prompt", "")).strip()
    context = request.get("context", {})
    if not isinstance(context, dict):
        context = {}
    status_path = Path(str(request.get("assistantStatusPath") or default_status_path())).expanduser()
    status: dict[str, Any] = {}
    if status_path.exists():
        try:
            loaded = read_json(status_path)
            if isinstance(loaded, dict):
                status = loaded
        except Exception:
            status = {}

    runtime_ready = bool(status.get("verified")) and bool(status.get("profileId"))
    use_model = runtime_ready and os.environ.get("OPENSTUDIO_ASSISTANT_DISABLE_MODEL", "").strip().lower() not in {
        "1",
        "true",
        "yes",
        "on",
    }

    if prompt == "":
        prompt = "Check assistant runtime status."

    append_assistant_log(
        "request_start",
        prompt=prompt[:1000],
        runtimeReady=runtime_ready,
        modelEnabled=use_model,
    )

    if is_capability_question(prompt):
        response = capability_response(runtime_ready, context)
        append_assistant_log(
            "capability_response",
            runtimeReady=runtime_ready,
        )
        return response

    if is_audio_understanding_license_question(prompt, context):
        reply, runtime_status = describe_audio_understanding_license(context)
        return {
            "ok": True,
            "mode": "answer",
            "reply": reply,
            "runtimeReady": runtime_ready,
            "runtimeStatus": runtime_status,
            "modelUsed": False,
            "fallbackUsed": False,
            "audioUnderstandingUsed": False,
            "audioUnderstandingStatus": runtime_status.get("audioUnderstandingStatus", "not_installed"),
        }

    if is_audio_understanding_status_question(prompt, context):
        reply, runtime_status = describe_audio_understanding_status(context)
        return {
            "ok": True,
            "mode": "answer",
            "reply": reply,
            "runtimeReady": runtime_ready,
            "runtimeStatus": runtime_status,
            "modelUsed": False,
            "fallbackUsed": False,
            "audioUnderstandingUsed": False,
            "audioUnderstandingStatus": runtime_status.get("audioUnderstandingStatus", "not_installed"),
        }

    if is_runtime_status_question(prompt):
        reply, runtime_status = describe_runtime_status(runtime_ready, context)
        return {
            "ok": True,
            "mode": "answer",
            "reply": reply,
            "runtimeReady": runtime_ready,
            "runtimeStatus": runtime_status,
            "modelUsed": False,
            "fallbackUsed": False,
            "audioUnderstandingUsed": False,
            "audioUnderstandingStatus": str(
                (context.get("aiToolsStatus", {}) if is_record(context.get("aiToolsStatus", {})) else {}).get(
                    "audioUnderstandingStatus",
                    "not_installed",
                )
            ),
        }

    if is_plugin_inventory_question(prompt):
        reply, plugin_status = describe_plugin_catalog(context)
        return {
            "ok": True,
            "mode": "answer",
            "reply": reply,
            "runtimeReady": runtime_ready,
            "runtimeStatus": {"pluginCatalog": plugin_status},
            "modelUsed": False,
            "fallbackUsed": False,
            "audioUnderstandingUsed": False,
            "audioUnderstandingStatus": str(
                (context.get("aiToolsStatus", {}) if is_record(context.get("aiToolsStatus", {})) else {}).get(
                    "audioUnderstandingStatus",
                    "not_installed",
                )
            ),
        }

    direct_audio_analysis = is_direct_audio_analysis_request(prompt)
    clip_context = find_clip_context(context)
    if direct_audio_analysis and not clip_context:
        return {
            "ok": True,
            "mode": "clarification",
            "reply": "Select an audio clip first so I know which file to analyze.",
            "missingContext": ["Select an audio clip."],
            "runtimeReady": runtime_ready,
            "modelUsed": False,
            "fallbackUsed": False,
            "audioUnderstandingUsed": False,
            "audioUnderstandingStatus": str(
                (context.get("aiToolsStatus", {}) if is_record(context.get("aiToolsStatus", {})) else {}).get(
                    "audioUnderstandingStatus",
                    "not_installed",
                )
            ),
        }

    if direct_audio_analysis:
        ai_tools = context.get("aiToolsStatus", {})
        if not is_record(ai_tools):
            ai_tools = {}
        context_analyzer_ready = bool(ai_tools.get("audioUnderstandingRuntimeReady"))
        if not context_analyzer_ready:
            reply, runtime_status = describe_audio_analysis_blocker(context, clip_context or {})
            return {
                "ok": True,
                "mode": "answer",
                "reply": reply,
                "runtimeReady": runtime_ready,
                "runtimeStatus": runtime_status,
                "modelUsed": False,
                "fallbackUsed": False,
                "audioUnderstandingUsed": False,
                "audioUnderstandingStatus": runtime_status.get("audioUnderstandingStatus", "not_installed"),
            }

    audio_understanding_used = False
    audio_understanding_error = ""
    audio_understanding_status = "not_installed"
    if wants_audio_understanding(prompt) and clip_context:
        audio_status_path = Path(
            str(request.get("audioUnderstandingStatusPath") or default_audio_understanding_status_path())
        ).expanduser()
        audio_status = load_optional_status(audio_status_path)
        audio_understanding_status = str(
            audio_status.get(
                "status",
                "ready" if bool(audio_status.get("verified")) and bool(audio_status.get("profileId")) else "not_installed",
            )
        )
        if bool(audio_status.get("verified")) and bool(audio_status.get("profileId")):
            try:
                summary = call_audio_understanding_analyzer(prompt, clip_context, audio_status)
                if summary:
                    context = {**context, "audioUnderstandingSummary": summary}
                    audio_understanding_used = True
                    audio_understanding_status = "ready"
            except Exception as exc:
                audio_understanding_error = f"{type(exc).__name__}: {exc}"
        elif audio_status:
            audio_understanding_error = str(audio_status.get("error", "")).strip()

    if direct_audio_analysis and audio_understanding_error and not audio_understanding_used:
        return {
            "ok": True,
            "mode": "answer",
            "reply": (
                "OpenStudio could not complete the selected-clip analysis because the core music analyzer failed. "
                f"{audio_understanding_error}"
            ),
            "runtimeReady": runtime_ready,
            "modelUsed": False,
            "fallbackUsed": False,
            "audioUnderstandingUsed": False,
            "audioUnderstandingStatus": audio_understanding_status,
            "audioUnderstandingError": audio_understanding_error,
        }

    if use_model:
        try:
            reply, assistant_plan, raw_text = call_qwen_plan(prompt, context, status)
            return {
                "ok": True,
                "mode": "plan",
                "reply": reply,
                "plan": assistant_plan,
                "runtimeReady": runtime_ready,
                "modelUsed": True,
                "rawText": raw_text[:2000],
                "audioUnderstandingUsed": audio_understanding_used,
                "audioUnderstandingStatus": audio_understanding_status,
                "audioUnderstandingError": audio_understanding_error,
            }
        except AssistantDirectResponse as exc:
            return {
                "ok": True,
                "mode": exc.mode,
                "reply": exc.message,
                "missingContext": exc.missing_context,
                "runtimeReady": runtime_ready,
                "modelUsed": True,
                "audioUnderstandingUsed": audio_understanding_used,
                "audioUnderstandingStatus": audio_understanding_status,
                "audioUnderstandingError": audio_understanding_error,
            }
        except AssistantClarificationNeeded as exc:
            return {
                "ok": True,
                "mode": "clarification",
                "reply": exc.message,
                "missingContext": exc.missing_context,
                "runtimeReady": runtime_ready,
                "modelUsed": True,
                "audioUnderstandingUsed": audio_understanding_used,
                "audioUnderstandingStatus": audio_understanding_status,
                "audioUnderstandingError": audio_understanding_error,
            }
        except Exception as exc:
            append_assistant_log(
                "model_plan_failed",
                error=f"{type(exc).__name__}: {exc}",
                prompt=prompt[:1000],
            )
            reply, assistant_plan = fallback_plan(prompt, context, runtime_ready)
            return {
                "ok": True,
                "mode": "plan",
                "reply": reply,
                "plan": assistant_plan,
                "runtimeReady": runtime_ready,
                "modelUsed": False,
                "fallbackUsed": True,
                "error": f"{type(exc).__name__}: {exc}",
                "audioUnderstandingUsed": audio_understanding_used,
                "audioUnderstandingStatus": audio_understanding_status,
                "audioUnderstandingError": audio_understanding_error,
            }

    if audio_understanding_used and clip_context:
        summary = context.get("audioUnderstandingSummary")
        if isinstance(summary, dict):
            return {
                "ok": True,
                "mode": "answer",
                "reply": describe_audio_understanding_summary(summary, clip_context),
                "runtimeReady": runtime_ready,
                "modelUsed": False,
                "fallbackUsed": False,
                "audioUnderstandingUsed": True,
                "audioUnderstandingStatus": audio_understanding_status,
                "audioUnderstandingError": audio_understanding_error,
            }

    if not use_model and not runtime_ready and not is_setup_request(prompt):
        return {
            "ok": True,
            "mode": "answer",
            "reply": (
                "The local Qwen planner is not verified yet, so I cannot produce model-backed DAW plans. "
                "For audio analysis, OpenStudio also needs the core music analyzer verified and an audio clip selected. "
                "Ask me to open AI Tools Setup when you want to install or verify the local runtimes."
            ),
            "runtimeReady": runtime_ready,
            "modelUsed": False,
            "fallbackUsed": False,
            "audioUnderstandingUsed": False,
            "audioUnderstandingStatus": audio_understanding_status,
        }

    reply, assistant_plan = fallback_plan(prompt, context, runtime_ready)
    return {
        "ok": True,
        "mode": "plan",
        "reply": reply,
        "plan": assistant_plan,
        "runtimeReady": runtime_ready,
        "modelUsed": False,
        "fallbackUsed": True,
        "audioUnderstandingUsed": False,
        "audioUnderstandingStatus": "not_installed",
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Run one OpenStudio assistant planning request.")
    parser.add_argument("--request", required=True, help="Path to request JSON.")
    args = parser.parse_args()
    request = read_json(Path(args.request))
    response = run(request if isinstance(request, dict) else {})
    print(json.dumps(response, ensure_ascii=True), flush=True)


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(
            json.dumps(
                {
                    "ok": False,
                    "mode": "answer",
                    "reply": "Assistant request failed.",
                    "error": f"{type(exc).__name__}: {exc}",
                },
                ensure_ascii=True,
            ),
            flush=True,
        )
        sys.exit(1)
