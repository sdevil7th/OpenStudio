"""Validate an AI component release before any runtime build or publication."""

import argparse
import json
from pathlib import Path
import re
import runpy
import subprocess


ROOT = Path(__file__).resolve().parents[1]
validate_notes = runpy.run_path(str(ROOT / "tools/validate-release-notes.py"))["validate"]


def resolve_release(raw_version: str, git_ref: str, repository_root: Path = ROOT) -> dict[str, str]:
    match = re.fullmatch(r"(?:ai-runtime-v|v)?([0-9]+\.[0-9]+\.[0-9]+)", raw_version)
    if match is None:
        raise ValueError("AI runtime version must have three numeric components, optionally prefixed by v or ai-runtime-v.")
    version = ".".join(str(int(part)) for part in match[1].split("."))
    tag = f"ai-runtime-v{version}"
    if "\n" in git_ref or "\r" in git_ref:
        raise ValueError("Invalid Git ref.")
    if git_ref.startswith("refs/tags/"):
        if git_ref != f"refs/tags/{tag}":
            raise ValueError("The selected tag must exactly match the normalized AI runtime version; application tags cannot publish runtimes.")
    elif not git_ref.startswith("refs/heads/") or git_ref == "refs/heads/":
        raise ValueError("AI runtime releases require a branch checkout or the matching AI runtime tag.")
    relative_notes = f"docs/releases/ai-runtime-{version}.md"
    root = repository_root.resolve()
    notes = (root / relative_notes).resolve()
    notes.relative_to(root)
    validate_notes(version, notes)
    return {"version": version, "runtime_tag": tag, "notes_file": relative_notes}


def validate_tag_source(tag: str, source_sha: str, remote_refs: str) -> None:
    """Compare lightweight or peeled annotated tags with the checked-out commit."""
    if not re.fullmatch(r"[0-9a-fA-F]{40}", source_sha):
        raise ValueError("The release source must be a full Git commit SHA.")
    base = f"refs/tags/{tag}"
    refs = {}
    for row in remote_refs.splitlines():
        parts = row.split()
        if len(parts) != 2 or not re.fullmatch(r"[0-9a-fA-F]{40}", parts[0]) or parts[1] not in (base, base + "^{}") or parts[1] in refs:
            raise ValueError("Cannot establish the remote runtime tag identity.")
        refs[parts[1]] = parts[0].lower()
    if base + "^{}" in refs and base not in refs:
        raise ValueError("The remote annotated tag has no matching tag reference.")
    if refs and refs.get(base + "^{}", refs[base]) != source_sha.lower():
        raise ValueError("The existing runtime tag points to a different source commit; use a new runtime version.")


def validate_release_response(returncode: int, response: str, tag: str) -> None:
    """Only an explicit REST 404 or an unpublished draft can proceed."""
    response = response.replace("\r\n", "\n")
    headers, separator, body = response.partition("\n\n")
    status = re.fullmatch(r"HTTP/\S+ ([0-9]{3})(?: .*)?", headers.split("\n", 1)[0])
    if not separator or status is None:
        raise ValueError("Cannot verify whether the runtime release is already published.")
    try:
        payload = json.loads(body)
    except (json.JSONDecodeError, TypeError) as error:
        raise ValueError("GitHub returned an invalid runtime release response.") from error
    if not isinstance(payload, dict):
        raise ValueError("GitHub returned an invalid runtime release response.")
    if status[1] == "404" and returncode == 1 and payload.get("message") == "Not Found":
        return
    if status[1] != "200" or returncode != 0:
        raise ValueError("GitHub runtime release lookup failed; authentication and network errors cannot bypass publication checks.")
    if payload.get("tag_name") != tag or not isinstance(payload.get("draft"), bool):
        raise ValueError("GitHub returned an unexpected runtime release identity.")
    if payload["draft"] and payload.get("published_at") is None:
        return
    raise ValueError("This runtime release is already published; published archives cannot be replaced. Use a new runtime version.")


def validate_publication_identity(repository: str, tag: str, source_sha: str, repository_root: Path = ROOT) -> None:
    if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", repository) or not re.fullmatch(r"ai-runtime-v[0-9]+\.[0-9]+\.[0-9]+", tag):
        raise ValueError("Invalid repository or runtime tag for publication lookup.")
    validate_tag_source(tag, source_sha, "")
    try:
        remote = subprocess.run(["git", "ls-remote", "origin", f"refs/tags/{tag}", f"refs/tags/{tag}^{{}}"], cwd=repository_root, capture_output=True, text=True, timeout=60)
        if remote.returncode != 0:
            raise ValueError("Cannot read the remote runtime tag; publication checks cannot be bypassed.")
        validate_tag_source(tag, source_sha, remote.stdout)
        response = subprocess.run(["gh", "api", "--hostname", "github.com", "--method", "GET", "--include", f"repos/{repository}/releases/tags/{tag}"], cwd=repository_root, capture_output=True, text=True, timeout=60)
    except (OSError, subprocess.TimeoutExpired) as error:
        raise ValueError("Cannot complete the read-only runtime publication checks.") from error
    validate_release_response(response.returncode, response.stdout, tag)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--version", required=True)
    parser.add_argument("--git-ref", required=True)
    parser.add_argument("--repository", required=True)
    parser.add_argument("--source-sha", required=True)
    parser.add_argument("--github-output", type=Path)
    args = parser.parse_args()
    try:
        release = resolve_release(args.version, args.git_ref, ROOT)
        validate_publication_identity(args.repository, release["runtime_tag"], args.source_sha, ROOT)
        if args.github_output:
            # Values are derived from numeric components and a fixed path, so
            # user input cannot inject another Actions output or shell command.
            with args.github_output.open("a", encoding="utf-8", newline="\n") as output:
                for name, value in release.items():
                    output.write(f"{name}={value}\n")
    except (OSError, ValueError, IndexError) as error:
        parser.error(str(error))
    print(f"AI runtime release validated: {release['runtime_tag']} ({release['notes_file']})")


if __name__ == "__main__":
    main()
