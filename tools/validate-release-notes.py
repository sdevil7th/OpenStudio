"""Fail release preparation before an unfinished or mismatched note is published."""
import argparse
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]
SECTIONS = ("Highlights", "Fixes", "Known Issues", "Upgrade Notes")
PLACEHOLDERS = re.compile(r"\{\{[^}]*\}\}|\b(?:TODO|TBD|FIXME)\b|summarize the biggest|list the important|document any other|call out any|replace this|fill (?:this|in)|insert .* here", re.I)


def validate(version: str, path: Path) -> str:
    version = version.removeprefix("v")
    if not re.fullmatch(r"\d+\.\d+\.\d+(?:\.\d+)?", version):
        raise ValueError("Release version must have three or four numeric components.")
    if "template" in path.name.lower():
        raise ValueError("A release-notes template cannot be published.")
    text = path.read_text(encoding="utf-8-sig").strip()
    if text.splitlines()[0] != f"# OpenStudio {version}":
        raise ValueError("Release-note title must match the exact release version.")
    if PLACEHOLDERS.search(text):
        raise ValueError("Release notes contain unfinished template text.")
    headings = re.findall(r"^## (.+)$", text, re.M)
    for section in SECTIONS:
        if headings.count(section) != 1:
            raise ValueError(f"Exactly one '{section}' section is required.")
        body = re.split(r"^## ", text.split(f"## {section}\n", 1)[1], maxsplit=1, flags=re.M)[0].strip()
        if len(body) < 35 or not re.search(r"^- .{20,}", body, re.M):
            raise ValueError(f"'{section}' needs a concrete user-facing explanation.")
    if not re.search(r"https://github\.com/[^\s)]+/(?:compare|commit|pull)/", text):
        raise ValueError("Include a source comparison, commit or pull-request link for this release.")
    return text + "\n"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--version", required=True)
    parser.add_argument("--notes-file", default="")
    parser.add_argument("--github-output", type=Path)
    args = parser.parse_args()
    version = args.version.removeprefix("v")
    if not re.fullmatch(r"\d+\.\d+\.\d+(?:\.\d+)?", version):
        parser.error("Invalid release version")
    path = (ROOT / (args.notes_file or f"docs/releases/{version}.md")).resolve()
    try:
        relative = path.relative_to(ROOT).as_posix()
        if "\n" in relative or "\r" in relative:
            raise ValueError("Invalid release-note path.")
        validate(version, path)
        if args.github_output:
            with args.github_output.open("a", encoding="utf-8") as output:
                output.write(f"notes_file={relative}\n")
    except (ValueError, OSError, IndexError) as error:
        parser.error(str(error))
    print(f"Release notes validated: {relative}")


if __name__ == "__main__":
    main()
