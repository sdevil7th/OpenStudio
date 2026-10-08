"""Exercise component version, source-ref and reviewed-note publication gates."""

import contextlib
import io
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest import mock

import yaml

from tools import ai_runtime_release as release


ROOT = Path(__file__).resolve().parents[1]
TAG = "ai-runtime-v0.0.15"
SHA = "a" * 40
OTHER_SHA = "b" * 40
TAG_OBJECT = "c" * 40


def api_response(status, payload, returncode=0):
    return subprocess.CompletedProcess([], returncode, f"HTTP/2.0 {status}\nContent-Type: application/json\n\n{json.dumps(payload)}", "")


NOTES = """# OpenStudio 0.0.15

AI runtime fixture. [Source comparison](https://github.com/sdevil7th/OpenStudio/compare/ai-runtime-v0.0.13...ai-runtime-v0.0.15).

## Highlights

- The Windows base archive uses the supported Python interpreter for worker setup.

## Fixes

- Published component artifacts retain their own source and dependency information.

## Known Issues

- Interpreter validation alone does not qualify GPU inference or subjective audio quality.

## Upgrade Notes

- Existing projects and cached model weights remain separate from runtime installation.
"""


class AiRuntimeReleaseTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.notes = self.root / "docs/releases/ai-runtime-0.0.15.md"
        self.notes.parent.mkdir(parents=True)
        self.notes.write_text(NOTES, encoding="utf-8")

    def resolve(self, version="0.0.15", git_ref="refs/heads/develop"):
        return release.resolve_release(version, git_ref, self.root)

    def invoke(self, version, git_ref, output, remote=None, api=None):
        remote = remote or subprocess.CompletedProcess([], 0, "", "")
        api = api or api_response("404 Not Found", {"message": "Not Found"}, 1)
        with mock.patch.object(release, "ROOT", self.root), mock.patch("sys.argv", [
            "ai_runtime_release.py", "--version", version, "--git-ref", git_ref,
            "--repository", "sdevil7th/OpenStudio", "--source-sha", SHA,
            "--github-output", str(output),
        ]), mock.patch.object(release.subprocess, "run", side_effect=[remote, api]), contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            release.main()

    def test_branch_dispatch_and_matching_tag_share_canonical_output(self):
        expected = {"version": "0.0.15", "runtime_tag": "ai-runtime-v0.0.15", "notes_file": "docs/releases/ai-runtime-0.0.15.md"}
        for raw in ("0.0.15", "v0.0.15", "ai-runtime-v0.0.15", "00.00.015"):
            for git_ref in ("refs/heads/main", "refs/heads/develop", "refs/tags/ai-runtime-v0.0.15"):
                with self.subTest(raw=raw, git_ref=git_ref):
                    self.assertEqual(self.resolve(raw, git_ref), expected)

    def test_application_tags_and_other_runtime_tags_cannot_be_reused(self):
        for git_ref in ("refs/tags/v0.1.04", "refs/tags/ai-runtime-v0.0.14", "refs/tags/ai-runtime-v0.0.015"):
            with self.subTest(git_ref=git_ref), self.assertRaisesRegex(ValueError, "exactly match"):
                self.resolve(git_ref=git_ref)

    def test_invalid_versions_and_refs_fail_before_publishing(self):
        for version in ("0.0.15-beta", "0.0", "0.0.15.1", "ai-runtime-vv0.0.15", "0.0.15\nother=secret", "$(command)", " 0.0.15", "../0.0.15"):
            with self.subTest(version=version), self.assertRaises(ValueError):
                self.resolve(version)
        for git_ref in ("refs/pull/27/merge", "refs/heads/", "main", "refs/heads/main\nother=secret"):
            with self.subTest(git_ref=git_ref), self.assertRaises(ValueError):
                self.resolve(git_ref=git_ref)

    def test_component_notes_are_required_even_when_application_notes_exist(self):
        self.notes.unlink()
        (self.notes.parent / "0.0.15.md").write_text(NOTES, encoding="utf-8")
        with self.assertRaises(FileNotFoundError):
            self.resolve()

    def test_unfinished_mismatched_or_incomplete_notes_are_rejected(self):
        for text in (NOTES.replace("# OpenStudio 0.0.15", "# OpenStudio 0.0.14"), NOTES + "\nTODO finish verification\n", NOTES.replace("## Known Issues", "## Remaining Work"), ""):
            with self.subTest(text=text):
                self.notes.write_text(text, encoding="utf-8")
                with self.assertRaises(ValueError):
                    self.resolve()

    def test_actions_outputs_are_safe_and_written_only_after_all_gates_pass(self):
        output = self.root / "github-output"
        output.write_text("previous=value\n", encoding="utf-8")
        self.invoke("v0.0.15", "refs/heads/develop", output)
        self.assertEqual(output.read_text(), "previous=value\nversion=0.0.15\nruntime_tag=ai-runtime-v0.0.15\nnotes_file=docs/releases/ai-runtime-0.0.15.md\n")
        for version, git_ref in (("0.0.15\nunsafe=value", "refs/heads/main"), ("0.0.15", "refs/tags/v0.1.04")):
            with self.subTest(version=version, git_ref=git_ref):
                before = output.read_bytes()
                with self.assertRaises(SystemExit) as error:
                    self.invoke(version, git_ref, output)
                self.assertEqual(error.exception.code, 2)
                self.assertEqual(output.read_bytes(), before)
        self.notes.write_text(NOTES + "\nTBD\n", encoding="utf-8")
        before = output.read_bytes()
        with self.assertRaises(SystemExit):
            self.invoke("0.0.15", "refs/heads/develop", output)
        self.assertEqual(output.read_bytes(), before)

    def test_lightweight_and_annotated_tags_must_resolve_to_the_reviewed_source(self):
        for refs in ("", f"{SHA}\trefs/tags/{TAG}\n", f"{TAG_OBJECT}\trefs/tags/{TAG}\n{SHA}\trefs/tags/{TAG}^{{}}\n"):
            with self.subTest(refs=refs):
                release.validate_tag_source(TAG, SHA, refs)
        for refs in (f"{OTHER_SHA}\trefs/tags/{TAG}\n", f"{SHA}\trefs/tags/{TAG}\n{OTHER_SHA}\trefs/tags/{TAG}^{{}}\n"):
            with self.subTest(refs=refs), self.assertRaisesRegex(ValueError, "different source"):
                release.validate_tag_source(TAG, SHA, refs)

    def test_malformed_or_ambiguous_remote_tag_identity_fails_closed(self):
        for refs in (f"{SHA}\trefs/tags/{TAG}^{{}}\n", f"{SHA}\trefs/tags/other\n", f"{SHA}\trefs/tags/{TAG}\n" * 2, f"bad\trefs/tags/{TAG}\n", "unexpected response", "\n"):
            with self.subTest(refs=refs), self.assertRaises(ValueError):
                release.validate_tag_source(TAG, SHA, refs)
        for source in ("main", "a" * 39, SHA + "\nother=value"):
            with self.subTest(source=source), self.assertRaises(ValueError):
                release.validate_tag_source(TAG, source, "")

    def test_missing_release_and_unpublished_draft_can_proceed(self):
        for response in (api_response("404 Not Found", {"message": "Not Found"}, 1), api_response("200 OK", {"tag_name": TAG, "draft": True, "published_at": None})):
            with self.subTest(response=response.stdout):
                release.validate_release_response(response.returncode, response.stdout, TAG)

    def test_published_releases_cannot_be_replaced_even_from_the_same_source(self):
        for draft in (False, True):
            response = api_response("200 OK", {"tag_name": TAG, "draft": draft, "published_at": "2026-10-08T00:00:00Z"})
            with self.subTest(draft=draft), self.assertRaisesRegex(ValueError, "already published"):
                release.validate_release_response(response.returncode, response.stdout, TAG)

    def test_auth_network_malformed_and_wrong_identity_responses_cannot_bypass_the_gate(self):
        cases = [api_response("401 Unauthorized", {"message": "Bad credentials"}, 1), api_response("403 Forbidden", {"message": "Forbidden"}, 1), api_response("429 Too Many Requests", {}, 1), api_response("404 Not Found", {"message": "Not Found"}), api_response("404 Not Found", {"message": "Authentication failed"}, 1), api_response("200 OK", {"tag_name": "ai-runtime-v0.0.14", "draft": True}), api_response("200 OK", {"tag_name": TAG, "draft": "true"}), api_response("200 OK", []), subprocess.CompletedProcess([], 1, "", "network failure"), subprocess.CompletedProcess([], 0, "HTTP/2.0 200 OK\n\nnot JSON", "")]
        for response in cases:
            with self.subTest(response=response.stdout), self.assertRaises(ValueError):
                release.validate_release_response(response.returncode, response.stdout, TAG)

    def test_publication_lookup_uses_only_exact_read_only_commands(self):
        responses = [subprocess.CompletedProcess([], 0, f"{TAG_OBJECT}\trefs/tags/{TAG}\n{SHA}\trefs/tags/{TAG}^{{}}\n", ""), api_response("404 Not Found", {"message": "Not Found"}, 1)]
        with mock.patch.object(release.subprocess, "run", side_effect=responses) as run:
            release.validate_publication_identity("sdevil7th/OpenStudio", TAG, SHA, self.root)
        self.assertEqual(run.call_args_list, [mock.call(["git", "ls-remote", "origin", f"refs/tags/{TAG}", f"refs/tags/{TAG}^{{}}"], cwd=self.root, capture_output=True, text=True, timeout=60), mock.call(["gh", "api", "--hostname", "github.com", "--method", "GET", "--include", f"repos/sdevil7th/OpenStudio/releases/tags/{TAG}"], cwd=self.root, capture_output=True, text=True, timeout=60)])
        for failure in (subprocess.CompletedProcess([], 1, "", "secret must not be printed"), FileNotFoundError("git unavailable"), subprocess.TimeoutExpired("git", 60)):
            with self.subTest(failure=failure), mock.patch.object(release.subprocess, "run", side_effect=[failure]), self.assertRaises(ValueError) as error:
                release.validate_publication_identity("sdevil7th/OpenStudio", TAG, SHA, self.root)
            self.assertNotIn("secret", str(error.exception))

    def test_remote_publication_failures_leave_actions_outputs_untouched(self):
        output = self.root / "github-output"
        output.write_text("previous=value\n", encoding="utf-8")
        cases = [(subprocess.CompletedProcess([], 0, f"{OTHER_SHA}\trefs/tags/{TAG}\n", ""), None), (None, api_response("200 OK", {"tag_name": TAG, "draft": False, "published_at": "2026-10-08T00:00:00Z"})), (None, api_response("403 Forbidden", {}, 1))]
        for remote, api in cases:
            with self.subTest(remote=remote, api=api), self.assertRaises(SystemExit):
                self.invoke("0.0.15", "refs/heads/develop", output, remote, api)
            self.assertEqual(output.read_text(), "previous=value\n")

    def test_workflow_builds_and_publication_require_the_same_gate(self):
        workflow = yaml.safe_load((ROOT / ".github/workflows/ai-runtime-release.yml").read_text(encoding="utf-8"))
        jobs = workflow["jobs"]
        gate = "validate-ai-runtime-release"
        for name, job in jobs.items():
            if name == gate:
                continue
            needs = job["needs"] if isinstance(job["needs"], list) else [job["needs"]]
            self.assertIn(gate, needs)
            self.assertEqual(job["env"]["VERSION"], "${{ needs.validate-ai-runtime-release.outputs.version }}")
        publish = next(step for step in jobs["publish-ai-runtime"]["steps"] if step.get("name") == "Publish AI runtime release")["with"]
        self.assertEqual(publish["tag_name"], "${{ needs.validate-ai-runtime-release.outputs.runtime_tag }}")
        self.assertEqual(publish["body_path"], "${{ needs.validate-ai-runtime-release.outputs.notes_file }}")
        self.assertEqual(publish["target_commitish"], "${{ github.sha }}")
        self.assertEqual(publish["make_latest"], "false")
        self.assertIs(publish["overwrite_files"], False)
        self.assertNotIn("body", publish)
        publish_job = jobs["publish-ai-runtime"]
        self.assertEqual(publish_job["concurrency"]["group"], "ai-runtime-publish-${{ needs.validate-ai-runtime-release.outputs.runtime_tag }}")
        self.assertIs(publish_job["concurrency"]["cancel-in-progress"], False)
        steps = publish_job["steps"]
        recheck = next(i for i, step in enumerate(steps) if step.get("name") == "Recheck runtime publication identity before publishing")
        publication = next(i for i, step in enumerate(steps) if step.get("name") == "Publish AI runtime release")
        self.assertEqual(recheck, publication - 1)
        self.assertIn("--source-sha", steps[recheck]["run"])
        self.assertIn("--repository", steps[recheck]["run"])

    def test_mac_cache_hit_does_not_bypass_current_archive_validation(self):
        workflow = yaml.safe_load((ROOT / ".github/workflows/ai-runtime-release.yml").read_text(encoding="utf-8"))
        steps = workflow["jobs"]["build-macos-runtime-arm64"]["steps"]
        prepare_index = next(i for i, step in enumerate(steps) if step.get("name") == "Prepare macOS arm64 runtime")
        validate_index = next(i for i, step in enumerate(steps) if step.get("name") == "Validate prepared or cached macOS runtime")
        upload_index = next(i for i, step in enumerate(steps) if step.get("with", {}).get("name") == "macos-arm64-ai-runtime")
        self.assertLess(prepare_index, validate_index)
        self.assertLess(validate_index, upload_index)
        self.assertNotIn("if", steps[validate_index])
        command = steps[validate_index]["run"]
        self.assertIn("validate-ai-runtime-package.ps1", command)
        self.assertIn('-ExpectedRuntimeFamily "macos-arm64"', command)
        self.assertIn("-ExpectedRuntimeVersion $env:VERSION", command)


if __name__ == "__main__":
    unittest.main()
