"""Select published AI archives without replacing a platform-specific hotfix."""

import argparse
import hashlib
import json
from pathlib import Path
import re


ASSETS = {
    "windows": "OpenStudio-AI-Runtime-windows-base-x64.zip",
    "macos": "OpenStudio-AI-Runtime-macos-arm64.zip",
    "linux": "OpenStudio-AI-Runtime-linux-cpu-x64.zip",
}


def validate_tag(value: str) -> str:
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._+-]{0,127}", value) or ".." in value or value.endswith("."):
        raise ValueError(f"Invalid AI runtime release tag: {value!r}")
    return value


def build_plan(repository: str, runtime_version: str, release_tag: str = "", linux_release_tag: str = "") -> dict:
    if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", repository):
        raise ValueError("Repository must be owner/name.")
    runtime_version = runtime_version.removeprefix("v")
    if not re.fullmatch(r"\d+\.\d+\.\d+", runtime_version):
        raise ValueError("AI runtime catalog version must have three numeric components.")
    release_tag = validate_tag(release_tag or f"ai-runtime-v{runtime_version}")
    linux_release_tag = validate_tag(linux_release_tag or release_tag)
    platforms = {}
    for platform, filename in ASSETS.items():
        tag = linux_release_tag if platform == "linux" else release_tag
        platforms[platform] = {
            "releaseTag": tag,
            "fileName": filename,
            "url": f"https://github.com/{repository}/releases/download/{tag}/{filename}",
        }
    # The catalog can combine independently versioned archives, as the live
    # schema-4 manifest already does. Installed status reads archive metadata.
    return {"runtimeVersion": runtime_version, "platforms": platforms}


def validate_releases(plan: dict, releases: dict, asset_dir: Path | None = None) -> None:
    for platform, expected in plan["platforms"].items():
        tag = expected["releaseTag"]
        release = releases.get(tag)
        if not isinstance(release, dict) or release.get("tag_name") != tag:
            raise ValueError(f"Missing or mismatched published release: {tag}")
        if release.get("draft") is not False or release.get("prerelease") is not False or not release.get("published_at"):
            raise ValueError(f"AI runtime release must be published and stable: {tag}")
        matches = [item for item in release.get("assets", []) if item.get("name") == expected["fileName"]]
        if len(matches) != 1:
            raise ValueError(f"Release {tag} must contain exactly one {expected['fileName']}")
        asset = matches[0]
        digest = asset.get("digest", "")
        size = asset.get("size")
        if asset.get("state") != "uploaded" or not isinstance(size, int) or isinstance(size, bool) or size <= 0:
            raise ValueError(f"Invalid published {platform} runtime asset size or upload state")
        if asset.get("browser_download_url") != expected["url"]:
            raise ValueError(f"Published {platform} runtime URL does not match the selected release")
        if not isinstance(digest, str) or not re.fullmatch(r"sha256:[0-9a-f]{64}", digest):
            raise ValueError(f"Published {platform} runtime asset is missing its SHA-256 digest")
        if asset_dir is not None:
            path = asset_dir / expected["fileName"]
            if not path.is_file() or path.stat().st_size != size:
                raise ValueError(f"Downloaded {platform} runtime size does not match its published asset")
            with path.open("rb") as stream:
                actual_hash = hashlib.file_digest(stream, "sha256").hexdigest()
            if actual_hash != digest.removeprefix("sha256:"):
                raise ValueError(f"Downloaded {platform} runtime SHA-256 does not match its published asset")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    plan_parser = commands.add_parser("plan")
    plan_parser.add_argument("--repository", required=True)
    plan_parser.add_argument("--runtime-version", required=True)
    plan_parser.add_argument("--release-tag", default="")
    plan_parser.add_argument("--linux-release-tag", default="")
    plan_parser.add_argument("--output", type=Path, required=True)
    verify_parser = commands.add_parser("verify")
    verify_parser.add_argument("--plan", type=Path, required=True)
    verify_parser.add_argument("--releases-dir", type=Path, required=True)
    verify_parser.add_argument("--asset-dir", type=Path)
    args = parser.parse_args()
    try:
        if args.command == "plan":
            plan = build_plan(args.repository, args.runtime_version, args.release_tag, args.linux_release_tag)
            args.output.parent.mkdir(parents=True, exist_ok=True)
            args.output.write_text(json.dumps(plan, indent=2) + "\n", encoding="utf-8")
        else:
            plan = json.loads(args.plan.read_text(encoding="utf-8"))
            releases = {
                tag: json.loads((args.releases_dir / f"{validate_tag(tag)}.json").read_text(encoding="utf-8"))
                for tag in {asset["releaseTag"] for asset in plan["platforms"].values()}
            }
            validate_releases(plan, releases, args.asset_dir)
            print("Selected published AI runtime assets verified" + (" against downloaded bytes." if args.asset_dir else "."))
    except (OSError, ValueError, KeyError, TypeError) as error:
        parser.error(str(error))


if __name__ == "__main__":
    main()
