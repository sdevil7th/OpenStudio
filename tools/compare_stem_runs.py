"""Bounded deterministic comparison; this does not assert subjective quality."""
import argparse
import json
from pathlib import Path


def compare(reference, candidate):
    import numpy as np
    import soundfile as sf
    left = json.loads(Path(reference).read_text())
    right = json.loads(Path(candidate).read_text())
    results = []
    for first, second in zip(left["cases"], right["cases"], strict=True):
        if first["status"] != "pass" or second["status"] != "pass":
            raise ValueError("Both inference runs must pass before comparison")
        stems = []
        for name, path in first["terminal"]["stems"].items():
            with sf.SoundFile(path) as a, sf.SoundFile(second["terminal"]["stems"][name]) as b:
                if (len(a), a.channels, a.samplerate) != (len(b), b.channels, b.samplerate):
                    raise ValueError("Stem shape/duration mismatch: " + name)
                max_pcm_difference = 0
                max_sample_difference = 0.0
                exact = True
                sample_exact = True
                while a.tell() < len(a):
                    x, y = a.read(65536, dtype="float64", always_2d=True), b.read(65536, dtype="float64", always_2d=True)
                    max_sample_difference = max(max_sample_difference, float(np.abs(x-y).max(initial=0)))
                    sample_exact = sample_exact and np.array_equal(x, y)
                    # libsndfile's integer conversion truncates toward the
                    # most significant PCM bits. Retain this compatibility
                    # metric alongside the full stored-sample comparison.
                    x, y = np.floor(x * 32768).clip(-32768, 32767), np.floor(y * 32768).clip(-32768, 32767)
                    difference = np.abs(x.astype("int32") - y.astype("int32"))
                    max_pcm_difference = max(max_pcm_difference, int(difference.max(initial=0)))
                    exact = exact and np.array_equal(x, y)
                stems.append({"stem": name, "pcm16Exact": exact, "maxPcm16Difference": max_pcm_difference,
                              "storedSamplesExact": sample_exact, "maxSampleDifference": max_sample_difference})
        results.append({"name": first["name"], "stems": stems,
                        "status": "pass" if all(s["maxPcm16Difference"] <= 1 for s in stems) else "fail"})
    return {"status": "pass" if all(c["status"] == "pass" for c in results) else "fail",
            "criterion": "same shape, maximum one PCM16 least-significant bit difference",
            "subjectiveAudioQuality": "not_asserted", "cases": results}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("reference")
    parser.add_argument("candidate")
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    result = compare(args.reference, args.candidate)
    Path(args.output).write_text(json.dumps(result, indent=2), encoding="utf-8")
    print(result["status"])
    raise SystemExit(0 if result["status"] == "pass" else 1)
