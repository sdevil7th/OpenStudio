# Code signing policy

**Draft for SignPath enrollment.** Account approval and production signing are
not yet verified. This page does not claim that current releases are signed or
that SignPath Foundation has accepted OpenStudio.

The proposed Windows signing process builds the public OpenStudio source on
GitHub-hosted runners, requests signing of the app/crash reporter, packages those
signed executables, then requests signing of the installer. A designated
maintainer must approve both requests before the signed release can be published.
Third-party binaries retain their upstream signing state.

Before publishing this policy as active, the repository owner must confirm:

- Authors/committers and reviewers: their names or GitHub team links.
- Signing approvers: their names or GitHub team links.
- A public privacy-policy URL covering actual network activity, including update
  checks, optional downloads and integrations, and applicable service policies.

After Foundation approval, include this attribution on the active policy page:

> Free code signing provided by [SignPath.io](https://signpath.io), certificate by
> [SignPath Foundation](https://signpath.org).

Link the active policy from the website's home and download/release pages.
Configuration and activation instructions are in [Windows signing](release-runbook.md#windows-signing-with-signpath).
