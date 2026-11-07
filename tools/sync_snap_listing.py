"""Verify the tagged Snap and synchronize its reviewed Store listing separately from upload."""
import argparse
import hashlib
import json
import logging
from pathlib import Path
import struct

from submit_snap_release import CHANNELS, SNAP_ID, file_digest, stable_revision, store_request, validate

ROOT = Path(__file__).resolve().parents[1]
DETAILS = f"/dev/api/snaps/{SNAP_ID}"


class ListingError(ValueError):
    """A diagnostic safe to include in a public Actions report."""


def listing_assets():
    listing = json.loads((ROOT / "packaging/snap/listing.json").read_text(encoding="utf-8"))
    paths = [("icon", ROOT / listing["iconSource"], listing["storeIconSha256"])]
    for screenshot in listing["screenshots"]:
        name = screenshot["file"]
        if Path(name).name != name or not name.endswith(".png"):
            raise ListingError("Invalid Snap screenshot filename.")
        paths.append(("screenshot", ROOT / "packaging/snap/gallery" / name, screenshot["sha256"]))
    media = {}
    for kind, path, digest in paths:
        data = path.read_bytes()
        if not data.startswith(b"\x89PNG\r\n\x1a\n") or hashlib.sha256(data).hexdigest() != digest:
            raise ListingError(f"Snap listing image differs from its reviewed source: {path.name}")
        width, height = struct.unpack(">II", data[16:24])
        if kind == "icon" and (width, height) != (512, 512):
            raise ListingError("Unexpected Snap icon dimensions.")
        if digest in media:
            raise ListingError("Duplicate image in Snap listing.")
        media[digest] = (kind, path.name, data)
    return listing, media


def metadata_changes(current, listing):
    changes = {key: listing[key] for key in ("title", "summary", "description", "license")
               if current.get(key) != listing[key]}
    if set(current.get("keywords") or []) != set(listing["keywords"]):
        changes["keywords"] = listing["keywords"]
    links = dict(current.get("links") or {})
    for key, source in (("website", "website"), ("contact", "contact"), ("issues", "issues"), ("source", "source-code")):
        if listing[source] not in links.get(key, []):
            links[key] = [listing[source], *links.get(key, [])]
    if links != current.get("links"):
        changes["links"] = links
    categories = current.get("categories") or {}
    names = [item["name"] for item in categories.get("items", [])]
    if listing["category"] not in names:
        if categories.get("locked"):
            raise ListingError("Canonical has locked the listing category. Review it in the dashboard.")
        changes["categories"] = [*names, listing["category"]]
    return changes


def sync_metadata(request, listing, media, *, apply):
    current = request("GET", DETAILS + "/metadata")
    existing = request("GET", DETAILS + "/binary-metadata")
    changes = metadata_changes(current, listing)
    known = {(item["type"], item["hash"]) for item in existing}
    missing = {digest: value for digest, value in media.items() if (value[0], digest) not in known}
    if apply and missing:
        # POST checks Store conflicts. Reference existing assets so a banner,
        # screenshot or localized artwork owned by the publisher is preserved.
        info = [{key: item[key] for key in ("type", "hash", "filename")} for item in existing]
        files = {}
        for digest, (kind, filename, data) in missing.items():
            key = "image_" + digest
            info.append(dict(key=key, type=kind, filename=filename, hash=digest))
            files[key] = (filename, data, "image/png")
        request("POST", DETAILS + "/binary-metadata", data={"info": json.dumps(info)}, files=files)
    if apply and changes:
        request("POST", DETAILS + "/metadata", json=changes)
    if apply:
        if metadata_changes(request("GET", DETAILS + "/metadata"), listing):
            raise ListingError("Snap Store listing text does not match the tagged source after update.")
        visible = {(item["type"], item["hash"]) for item in request("GET", DETAILS + "/binary-metadata")}
        expected = {(kind, digest) for digest, (kind, _, _) in media.items()}
        if not (known | expected) <= visible:
            raise ListingError("Snap Store gallery readback is incomplete.")
    return {"textFieldsToUpdate": sorted(changes), "imagesToAdd": len(missing), "listingVerified": apply}


def run(directory, version, tag, *, apply, request):
    if tag != "v" + version:
        raise ListingError("Listing operations require the exact application tag.")
    package, qualification = validate(directory, version)
    listing, media = listing_assets()
    result = {"version": version, "tag": tag, "snapSha256": qualification["snapSha256"]}
    revision = stable_revision(request("GET", CHANNELS))
    if apply:
        digest = file_digest(package, "sha3_384")
        if not revision or revision["version"] != version or revision["sha3-384"] != digest:
            raise ListingError("Stable amd64 does not serve the qualified tagged Snap. Check the Store before retrying.")
        result["revision"] = revision["revision"]
    result.update(sync_metadata(request, listing, media, apply=apply))
    if apply and stable_revision(request("GET", CHANNELS)) != revision:
        raise ListingError("Stable changed during listing verification.")
    return result


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--directory", required=True, type=Path)
    parser.add_argument("--version", required=True)
    parser.add_argument("--tag", required=True)
    parser.add_argument("--report", required=True, type=Path)
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    logging.disable(logging.CRITICAL)
    try:
        result = run(args.directory, args.version, args.tag, apply=args.apply, request=store_request())
        result["status"] = "verified" if args.apply else "preflight_passed"
    except Exception as error:
        # SDK exceptions can contain authentication responses. Only emit our own diagnostics.
        result = {"status": "failed", "tag": args.tag, "errorType": type(error).__name__,
                  "message": str(error) if isinstance(error, ListingError) else "Check the Snap Store listing, credential access and channel."}
    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(result))
    raise SystemExit(1 if result["status"] == "failed" else 0)
