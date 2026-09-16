"""Reject retired product identifiers in first-party files and paths."""
from pathlib import Path
import re
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
RETIRED = re.compile(r"s(?:tudio)?1[3]", re.I)
OWNED = {"Source", "frontend", "tools", "tests", "docs", "packaging", "effects", "resources",
         "cmake", "assets", ".github", ".agent", ".claude"}


def main():
    paths = subprocess.check_output(
        ["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z"], cwd=ROOT
    ).decode("utf-8").split("\0")
    failures = []
    for name in sorted(set(paths)):
        path = Path(name)
        if not name or (len(path.parts) > 1 and path.parts[0] not in OWNED):
            continue
        actual = ROOT / path
        if not actual.is_file() or path.name.endswith("lock.json"):
            continue
        if RETIRED.search(name):
            failures.append(f"{name}: retired filename")
        try:
            content = actual.read_text(encoding="utf-8-sig")
        except UnicodeDecodeError:
            continue
        for index, line in enumerate(content.splitlines(), 1):
            if RETIRED.search(line):
                failures.append(f"{name}:{index}: retired product identifier")
    if failures:
        print("\n".join(failures), file=sys.stderr)
        return 1
    print("First-party product naming check passed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
