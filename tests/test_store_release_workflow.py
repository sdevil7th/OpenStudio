"""Exercise the release workflow's Store dependency graph and safety gates."""

import ast
import json
from pathlib import Path
import re
import shlex
import unittest

import yaml


ROOT = Path(__file__).resolve().parents[1]


def evaluate_condition(expression, values, cancelled=False):
    """Evaluate only the boolean/string operators used by these job gates."""
    expression = expression.strip()
    if expression.startswith("${{") and expression.endswith("}}"):
        expression = expression[3:-2].strip()
    expression = re.sub(
        r"startsWith\(([\w.-]+),\s*'([^']*)'\)",
        lambda match: str(values[match[1]].startswith(match[2])), expression,
    )
    expression = expression.replace("cancelled()", str(cancelled))
    expression = re.sub(
        r"\b(?:vars|github|needs)\.[\w.-]+",
        lambda match: repr(values[match[0]]), expression,
    )
    expression = expression.replace("&&", " and ").replace("||", " or ")
    expression = re.sub(r"!(?!=)", " not ", expression).strip()

    def evaluate(node):
        if isinstance(node, ast.Constant) and isinstance(node.value, (str, bool)):
            return node.value
        if isinstance(node, ast.BoolOp):
            operands = [evaluate(value) for value in node.values]
            if isinstance(node.op, ast.And):
                return all(operands)
            if isinstance(node.op, ast.Or):
                return any(operands)
        if isinstance(node, ast.UnaryOp) and isinstance(node.op, ast.Not):
            return not evaluate(node.operand)
        if isinstance(node, ast.Compare) and len(node.ops) == 1:
            left, right = evaluate(node.left), evaluate(node.comparators[0])
            if isinstance(node.ops[0], ast.Eq):
                return left == right
            if isinstance(node.ops[0], ast.NotEq):
                return left != right
        raise AssertionError(f"Unsupported release gate expression: {ast.dump(node)}")

    return evaluate(ast.parse(f"({expression})", mode="eval").body)


class StoreReleaseWorkflowTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.workflow = yaml.safe_load(
            (ROOT / ".github/workflows/release.yml").read_text(encoding="utf-8")
        )
        cls.jobs = cls.workflow["jobs"]

    def job_runs(self, name, results=None, enabled="true", ref="refs/tags/v0.1.04", cancelled=False):
        job = self.jobs[name]
        needs = job.get("needs", [])
        if isinstance(needs, str):
            needs = [needs]
        statuses = dict.fromkeys(needs, "success")
        statuses.update(results or {})
        expression = job.get("if", "True")
        # Actions adds success() implicitly unless a status function is present.
        if not re.search(r"\b(?:always|cancelled|failure|success)\(", expression):
            if cancelled or any(statuses[need] != "success" for need in needs):
                return False
        values = {
            "vars.OPENSTUDIO_STORE_ENABLED": enabled,
            "github.ref": ref,
            **{f"needs.{name}.result": status for name, status in statuses.items()},
        }
        return evaluate_condition(expression, values, cancelled)

    def test_tag_push_triggers_release_without_manual_dispatch(self):
        # PyYAML's YAML 1.1 loader recognizes the unquoted key `on` as True.
        triggers = self.workflow.get("on", self.workflow.get(True))
        self.assertEqual(triggers["push"]["tags"], ["v*"])
        self.assertIn("workflow_dispatch", triggers)

    def test_enabled_tag_automatically_preflights_and_submits(self):
        self.assertTrue(self.job_runs("preflight-store"))
        self.assertTrue(self.job_runs("publish"))
        self.assertTrue(self.job_runs("submit-store"))
        for enabled, ref in (("false", "refs/tags/v0.1.04"), ("true", "refs/heads/develop")):
            with self.subTest(enabled=enabled, ref=ref):
                self.assertFalse(self.job_runs("preflight-store", enabled=enabled, ref=ref))
                self.assertFalse(self.job_runs("submit-store", enabled=enabled, ref=ref))

    def test_store_readiness_failure_or_cancellation_blocks_release_publication(self):
        for status in ("failure", "cancelled", "skipped"):
            with self.subTest(status=status):
                self.assertFalse(self.job_runs("publish", {"preflight-store": status}))
        self.assertFalse(self.job_runs("publish", cancelled=True))

    def test_store_readiness_waits_for_validated_notes_and_windows_package(self):
        self.assertCountEqual(self.jobs["preflight-store"]["needs"], [
            "build-windows", "validate-release-notes",
        ])
        for dependency in self.jobs["preflight-store"]["needs"]:
            for status in ("failure", "cancelled", "skipped"):
                with self.subTest(dependency=dependency, status=status):
                    self.assertFalse(self.job_runs("preflight-store", {dependency: status}))

    def test_skipped_store_gate_only_allows_non_store_publication(self):
        results = {"preflight-store": "skipped"}
        self.assertTrue(self.job_runs("publish", results, enabled="false"))
        self.assertTrue(self.job_runs("publish", results, ref="refs/heads/develop"))
        for status in ("failure", "cancelled"):
            with self.subTest(status=status):
                self.assertFalse(self.job_runs("publish", {"preflight-store": status}, enabled="false"))

    def test_each_failed_build_or_notes_gate_blocks_publication(self):
        for dependency in ("validate-release-notes", "build-windows", "build-macos", "build-linux"):
            for status in ("failure", "cancelled", "skipped"):
                with self.subTest(dependency=dependency, status=status):
                    self.assertFalse(self.job_runs("publish", {dependency: status}))

    def test_submission_requires_successful_publication_and_current_windows_package(self):
        for dependency in ("publish", "build-windows", "validate-release-notes"):
            self.assertIn(dependency, self.jobs["submit-store"]["needs"])
            for status in ("failure", "cancelled", "skipped"):
                with self.subTest(dependency=dependency, status=status):
                    self.assertFalse(self.job_runs("submit-store", {dependency: status}))
        self.assertFalse(self.job_runs("submit-store", cancelled=True))

    def test_website_failure_does_not_suppress_store_submission(self):
        self.assertEqual(self.jobs["publish-website"]["needs"], "publish")
        self.assertNotIn("publish-website", self.jobs["submit-store"]["needs"])
        self.assertTrue(self.job_runs("submit-store", {"publish-website": "failure"}))
        self.assertFalse(self.job_runs("publish-website", {"publish": "failure"}))
        publish_actions = [step.get("uses", "") for step in self.jobs["publish"]["steps"]]
        self.assertFalse(any("repository-dispatch" in action for action in publish_actions))

    def test_both_store_stages_reuse_the_validated_msix_artifact(self):
        uploads = [step for step in self.jobs["build-windows"]["steps"]
                   if "actions/upload-artifact@" in step.get("uses", "")
                   and step.get("with", {}).get("name") == "microsoft-store-package"]
        self.assertEqual(len(uploads), 1)
        self.assertIn("dist/store/*.msix", uploads[0]["with"]["path"].splitlines())
        self.assertEqual(uploads[0]["with"]["if-no-files-found"], "error")
        for name in ("preflight-store", "submit-store"):
            with self.subTest(job=name):
                downloads = [step["with"] for step in self.jobs[name]["steps"]
                             if "actions/download-artifact@" in step.get("uses", "")]
                self.assertEqual(downloads, [{"name": "microsoft-store-package", "path": "dist/store"}])
                self.assertFalse(any("package-windows-store.ps1" in step.get("run", "")
                                     for step in self.jobs[name]["steps"]))

    def test_prepublish_store_check_is_read_only_and_submission_rechecks_readiness(self):
        for name in ("preflight-store", "submit-store"):
            commands = [step["run"] for step in self.jobs[name]["steps"]
                        if "submit_store_release.py" in step.get("run", "")]
            self.assertIn("--preflight", commands[0])
            self.assertIn("--package-dir dist/store", commands[0])
            self.assertIn('--notes-file "$RELEASE_NOTES_FILE"', commands[0])
            self.assertIn("Require the exact release tag", [step.get("name") for step in self.jobs[name]["steps"]])
            if name == "preflight-store":
                self.assertEqual(len(commands), 1)
                self.assertNotIn("--submit", commands[0])
            else:
                self.assertEqual(len(commands), 2)
                self.assertIn("--submit", commands[1])
        self.assertIn("preflight-store", self.jobs["publish"]["needs"])

    def test_store_jobs_use_protected_environment_and_mutations_are_serialized(self):
        for name in ("preflight-store", "submit-store"):
            self.assertEqual(self.jobs[name]["environment"], "microsoft-store")
            self.assertEqual(self.jobs[name]["permissions"], {"contents": "read", "actions": "read"})
        self.assertEqual(self.jobs["submit-store"]["concurrency"], {
            "group": "openstudio-microsoft-store-submission", "cancel-in-progress": False,
        })

    def test_preflights_and_submission_share_the_reviewed_publishing_policy(self):
        config_path = "packaging/msix/release-publishing.json"
        policy = json.loads((ROOT / config_path).read_text(encoding="utf-8"))
        self.assertEqual(policy, {
            "appId": "9N3MQ442VXGW", "releaseTag": "v0.1.04", "targetPublishMode": "Immediate",
        })
        commands = [step["run"] for name in ("preflight-store", "submit-store")
                    for step in self.jobs[name]["steps"]
                    if "submit_store_release.py" in step.get("run", "")]
        self.assertEqual(len(commands), 3)
        for command in commands:
            with self.subTest(command=command):
                arguments = shlex.split(command)
                self.assertEqual(arguments.count("--publishing-config"), 1)
                self.assertEqual(arguments[arguments.index("--publishing-config") + 1], config_path)


if __name__ == "__main__":
    unittest.main()
