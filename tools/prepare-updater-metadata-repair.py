"""Prepare a signed metadata-only correction; never upload or alter binaries."""
import argparse
import copy
import json
from pathlib import Path
import urllib.request
import xml.etree.ElementTree as ET

from updater_manifest import ROOT, load_private_key, public_key, sign, verify


def get(url):
    request = urllib.request.Request(url, headers={"User-Agent": "OpenStudio-metadata-repair"})
    with urllib.request.urlopen(request, timeout=30) as response:
        if response.status != 200:
            raise ValueError("Metadata source is unavailable.")
        return response.read(2 * 1024 * 1024)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--version", required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    args = parser.parse_args()
    version = args.version.removeprefix("v")
    notes = (ROOT / f"docs/releases/{version}.md").read_text(encoding="utf-8")
    release_base = f"https://github.com/sdevil7th/OpenStudio/releases/download/v{version}"
    manifest = json.loads(get(release_base + "/OpenStudio-release-stable-latest.json"))
    if manifest["version"] != version or manifest["channel"] != "stable":
        raise ValueError("The requested version does not match the existing release metadata.")
    release = json.loads(get(f"https://api.github.com/repos/sdevil7th/OpenStudio/releases/tags/v{version}"))
    assets = {asset["browser_download_url"]: asset for asset in release["assets"]}
    original = copy.deepcopy(manifest)
    manifest["notes"] = notes
    for platform, node in manifest["platforms"].items():
        asset = assets[node["url"]]
        if asset["size"] != node["size"] or asset["digest"] != "sha256:" + node["sha256"]:
            raise ValueError("Existing release asset identity disagrees with the manifest.")
        node["architectures"] = ["arm64", "x86_64"] if platform == "macos" else ["x86_64"]
        if platform == "windows":
            node["minimumSystemVersion"] = "10"
        if platform == "linux":
            node["minimumGlibcVersion"] = "2.39"
    envelope = sign(manifest, load_private_key(), public_key())
    verify(envelope, public_key())
    output = args.output_dir
    for relative in ("releases/latest.json", "releases/stable/latest.json"):
        path = output / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(envelope, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    for prefix, namespace in [("sparkle", "http://www.andymatuschak.org/xml-namespaces/sparkle"),
                              ("openstudio", "https://openstudio.org.in/xmlns/appcast")]:
        ET.register_namespace(prefix, namespace)
    for platform in manifest["platforms"]:
        tree = ET.fromstring(get(release_base + f"/OpenStudio-appcast-{platform}-stable.xml"))
        tree.find("channel/item/description").text = notes
        enclosure = tree.find("channel/item/enclosure")
        node = manifest["platforms"][platform]
        if enclosure.get("url") != node["url"] or int(enclosure.get("length")) != node["size"]:
            raise ValueError("Appcast differs from the existing release package.")
        path = output / f"appcast/{platform}-stable.xml"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(ET.tostring(tree, encoding="utf-8", xml_declaration=True))
    (output / "OpenStudio-checksums.txt").write_bytes(get(release_base + "/OpenStudio-checksums.txt"))
    (output / "repair-review.json").write_text(json.dumps({
        "version": version, "scope": "metadata only; no binaries replaced",
        "originalPlatforms": original["platforms"], "correctedPlatforms": manifest["platforms"],
        "notesSource": f"docs/releases/{version}.md", "publisherSignatureVerified": True,
        "published": False,
    }, indent=2) + "\n")
    print(f"Prepared signed metadata correction at {output}. Nothing was published.")


if __name__ == "__main__":
    main()
