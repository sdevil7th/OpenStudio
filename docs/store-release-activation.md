# Microsoft Store activation plan

Status recorded: September 16, 2026.

## Current status and the evidence still needed

PR #20 merged at `3aaf47e324461ca7b63848b0be10327e8305cf4f` and the
`v0.1.03` tag points to that commit. All three platform builds and GitHub
publication passed in [Release #45](https://github.com/sdevil7th/OpenStudio/actions/runs/35099203025).
The website publish job passed. Post-merge Verify passed after one Windows
browser-test timeout was rerun on unchanged source (100 browser tests passed).

**Store automation is configured, but end-to-end submission is not yet proven.**
The tag automatically started the Store job and authenticated successfully.
Its read-only preflight stopped because the initial draft was not `PendingCommit`.
That run did not record the actual API state, so do not infer a specific state
from the portal's **In draft** label. No Store mutation ran in GitHub.

The browser fallback uploaded the same run's `OpenStudio-0.1.3.0-x64.msix`,
removed the `0.0.1.0` placeholder, saved current release/certification notes,
and submitted draft `1152921505701841400`. Package SHA-256:
`f84c9ecf4bf85a3c035400f9759af8351a47ac1506331da975ceaab8a008444e`.
The nine approved artwork slots were retained. Partner Center subsequently
showed **Certification in progress**, with public publication held until
**Publish now**. This was a manual portal submission, not an automation pass.

The follow-up workflow runs `preflight-store` against the exact tagged MSIX
before GitHub publication. Failure blocks publication and retains sanitized
state/error evidence. The submit job still repeats preflight immediately before
mutation, because Store state can change between jobs. This check cannot prove
upload/commit permissions or acceptance; a successful live submission must do that.

To qualify automation after this first version is certified and deliberately
published, use the next reviewed higher-version release, with no unrelated Store
draft pending. Require all of the following evidence from that tag's run:

1. `preflight-store` passes using the protected `microsoft-store` environment.
2. `submit-store` uploads and commits without a browser fallback, and finishes
   successfully with a real submission ID and an accepted ingestion state.
3. Its retained report matches the tag, normalized package version and MSIX hash.
4. Partner Center shows the same submission/version entering preprocessing or
   certification, with the intended artwork and publication hold.

Only then record **automated submission verified**. Certification approval and
a Store-installed upgrade remain separate checks. Do not rerun the old Store
job or cancel the current certification to manufacture a green workflow.

## Historical checkpoint after the failed v0.1.02 run

PR #19 merged into main at `dbe34f4`; all ten post-merge Verify checks passed.
The local Windows RC build, runtime/startup checks and installer packaging passed.
After the owner completed GitHub identity confirmation, `OPENSTUDIO_STORE_ENABLED`
was saved as `true` and `v0.1.02` was pushed on that exact merged commit.

[Release #44](https://github.com/sdevil7th/OpenStudio/actions/runs/35089655608)
failed in Windows MSIX packaging with `Missing runtime directory: presets`.
The clean checkout contains no bundled presets directory; a developer's existing
output had hidden the assumption. Publication and Store submission were skipped.
No Store API credential was exercised and the prepared draft was not modified.
Linux and macOS release jobs and the separate updater-safety workflow passed.

The packaging follow-up treats only bundled presets as optional, with regression
coverage for clean staging, optional preset preservation and missing required
payloads. A complete MSIX and its unpacked payload verification passed locally
from the clean Release output. That artifact is test evidence, not an upload.
The retry candidate is `v0.1.03`; its reviewed notes and first-submission config
must pass CI and merge before tagging. Preserve the existing failed `v0.1.02` tag.
Credentials and tag restrictions are unchanged; public Store publication remains
manually held. Live Store preflight and certification are still pending.

## September 16 checkpoint before tag activation

The owner explicitly does **not** want the old code or old branding published.
The old Submission 1 had passed certification with a manual publishing hold.
Its certification was cancelled to replace the old code and artwork, and Partner
Center now shows **In draft** (submission `1152921505701841400`). Nothing was
published. Do not publish the old package to establish a baseline. Release PR #17 passed its PR checks and was
merged into `main` at `196707f`. Follow-up PR #18 contains corrected
release notes, unconditional MSIX packaging/artifact retention, and explicit
first-submission support for the existing draft; its CI is
pending. Merge that preparation only after CI passes, then tag the final merged
revision. Use only the MSIX built by that tag's Release workflow.
The local candidate upload was cancelled, removed, and the removal saved and
verified in Partner Center; the draft currently retains only the old package.
Do not use the locally built `681fec8` package for submission, even though its
application source matches the release candidate. Nothing has been resubmitted.

The English Store listing's nine logo/promotional slots were saved using only
files from the owner-designated directory
`C:\Users\srvds\OneDrive\Pictures\microsoft-store`: app tiles at 71, 150 and
300 pixels; poster at 1440x2160; box art at 2160x2160; super hero at 3840x2160;
branded key art at 584x800; titled hero at 1920x1080; and featured promotional
square at 1080x1080. Earlier website-export uploads were replaced. Reopening the
listing confirmed that all nine preview images persisted unchanged after Save.
Existing desktop screenshots and listing text were not changed. These are draft
listing updates only; the final tagged MSIX and certification submission remain
pending. The capability explanation was shortened to a complete 470-character
statement within the portal's 500-character limit. After saving, Submission
options now shows Complete. The manual publishing hold remains selected.

The working tree was clean at `681fec8` when release preparation resumed.
`docs/releases/0.1.02.md` has been reviewed and updated for that candidate,
including the new branding, saved INT8 variants, plugin automation/state changes
and recording finalization recovery. Notes validation passed and icons were
regenerated from the approved master. These notes are preparation changes, not
evidence of a published release or a qualified installed package.

GitHub's `microsoft-store` environment now contains all three required secrets:
`MS_STORE_TENANT_ID`, `MS_STORE_CLIENT_ID`, and `MS_STORE_CLIENT_SECRET`.
Repository variable `OPENSTUDIO_STORE_ENABLED` remains `false`. Deployment access
is restricted to tags matching `v*`, with zero branches allowed. A manually
dispatched release must use an eligible tag ref to access these credentials.
The secret value was transferred directly from Microsoft into GitHub's encrypted
environment secret; it was not printed or written to local/repository files, and
temporary in-memory transfer values were cleared afterward.

The owner completed Entra tenant setup, authentication and association with the
existing Partner Center account. After explicit owner confirmation, the
`OpenStudio GitHub Store Release` application was created with Manager (Windows)
access and `https://openstudio.org.in/` as its Reply URL. One API key was generated,
saved in GitHub, and verified in Microsoft's masked key list; it expires on
September 16, 2028. Tenant/client identifiers and the key value are kept in the
GitHub environment secrets rather than this document. Credential provisioning
is complete, but live Store API authentication remains unverified.

The local package checks below are supporting evidence only. PR #18 implements
the first-release path: passing CI, merge, enable submission, tag, successful
tagged Release run, authenticated read-only preflight, then submit that run's
exact MSIX into the prepared draft for certification. The new config in
`packaging/msix/initial-submission.json` permits only draft `1152921505701841400`
for `v0.1.02`, replacing the existing `0.0.1.0` package. It requires saved artwork
and the manual publishing hold, preserves listing/settings, and binds retries
to the artifact, notes and settings. Other unpublished drafts remain blocked.
The existing published-baseline path remains in use for subsequent versions.

MSIX building works while `OPENSTUDIO_STORE_ENABLED=false`. The flag is still
false during PR review; enable it after passing CI/merge and before the release
tag. Live API access has not yet been tested: the GitHub secrets are restricted
to `v*` tags and are not readable back from GitHub. The tagged job now performs
mandatory live preflight before any Store mutation and stops on failure. Keep
the manual publishing hold through certification. The pinned `ai-runtime-v0.0.13`
release and all three platform runtime assets were confirmed available.

September 16 local checks: 35 passed and 2 skipped across Store submission,
release-note and model-variant tests; all 5 Store package rejection tests passed.
These are local deterministic checks, not live certification or Store delivery.

The frontend production build and CMake Release build completed with no reported
C++ compiler warnings. Runtime-bundle validation and startup prerequisite checks
passed. The candidate is
`dist/store/0.1.02-candidate/OpenStudio-0.1.2.0-x64.msix`, with SHA256
`9e1c248b5cf7833c535e26631e65542605117a098c352c8696d29c2669bc34b5`.
MakeAppx validation, unpacked payload hash parity and the offline submission
validator passed. Matching Release binaries/PDBs are retained under
`output/symbols/Release-D8E61B90F38AFE6966404965F855FDA03A8B62241A8DB0D303B5C17632B60244`.

The pre-existing unsigned development registration (`0.0.1.0`) was updated to
the candidate (`0.1.2.0`); no Store-signed installation was replaced. Package
identity/update-routing checks, startup prerequisites and all 42 window-lifecycle
checks passed in `output/review/store-installed-20260916-112547/`. The fixed
WebView2 runtime is used and all required browser roles reached frontend readiness.
The test process exited. This is **development-registration** evidence only:
Store certification/delivery, private-flight upgrades, clean-machine dependency
independence, hardware/audio quality and live OAuth remain **not_asserted**.

The September 14 checkpoint and steps below are historical. Where they conflict
with this section, the current release decision above is authoritative.

## September 14 account-access checkpoint

The owner reports that the privacy URL was changed from the GitHub repository to
`https://openstudio.org.in/privacy`, reviewer notes were saved, and Submission 1
was resubmitted. The connected Chrome session now independently confirms **In
certification**, preprocessing in progress, and the existing **Publish now** hold.
The earlier rejection/deployment tasks below are historical; do not resubmit or
cancel the in-progress certification.

Browser access is now available. GitHub was checked again: all three environment
secrets are still absent and `OPENSTUDIO_STORE_ENABLED` remains `false`.
Partner Center **User management** explicitly requires signing in with associated
Microsoft Entra ID credentials; the current personal Microsoft account cannot
manage users from that session. The Microsoft sign-in page is open in Chrome for
the owner to complete the Entra sign-in. No tenant ID, client ID, or client secret
has been generated or added yet. Once this sign-in is complete, continue the
release application's setup and GitHub secret storage. If no Entra account exists,
tenant creation/association must be resolved first.

The owner reports that the initial Partner Center submission failed a privacy
policy check. The exact certification report is still needed. The owner will
publish the website changes. No new application tag or Store submission has been
created as part of this setup.

## Completed

- Confirmed GitHub administrator access to `sdevil7th/OpenStudio` through the
  existing local Git authentication. No credential values were printed or saved.
- Created the GitHub environment `microsoft-store` and verified it exists.
- Created and verified the repository Actions variable
  `OPENSTUDIO_STORE_ENABLED=false`. Keep this false until the first published
  Store submission and installed qualification are confirmed.
- Verified that the environment currently has no secrets.
- Ran `python -m unittest tests.test_store_submission`: 20 tests passed.
- Ran `tools/test-windows-store-package.ps1`: five rejection tests passed.
  These checks do not prove live Microsoft authentication, package installation,
  certification, or Store delivery.
- Reviewed the local website privacy document at
  `../openstudio-website/src/data/legal.ts`. Its September 10, 2026 revision covers
  desktop audio/projects, optional TONE3000 and AI features, website analytics,
  diagnostics, retention, deletion, and contact details. Spot-checked desktop
  source for TONE3000 DPAPI protection, loopback authentication, token refresh,
  and local crash dump writing. This is not a complete audit of the rejected
  binary, whose version is not yet known.
- After the owner confirmed deployment, both public privacy URL forms returned
  HTTP 200 and their static HTML included the September 10, 2026 revision,
  responsibility section, TONE3000 section, privacy controls, and support contact.
  These were unauthenticated requests, with script/style contents excluded from
  text checks. Visual readability and the exact rejection cause remain unverified.
- The owner supplied the product overview URL:
  `https://partner.microsoft.com/en-us/dashboard/products/9N3MQ442VXGW/overview`.
  This does not expose the authenticated certification report to the current
  session. A fresh browser inventory still returned no connected browsers.

## Remaining steps, in order

1. Obtain the exact certification failure text, policy number, rejected package
   version, and current submission status from Partner Center. Browser inventory
   was empty; attempts to open the in-app browser and Chrome returned "Browser is
   not available". The owner must provide this information or make an
   authenticated browser available.
2. After the owner deploys the website, verify
   `https://openstudio.org.in/privacy` and `/privacy/`, the latest policy text,
   contact link, and access without login or analytics acceptance. Verify the
   static policy remains readable when JavaScript cannot load. Compare the
   failure report with the actual deployed page before declaring it addressed.
3. Correct the existing initial submission in Partner Center. In the privacy
   section, use **Yes** for access/collection/transmission of personal
   information and provide `https://openstudio.org.in/privacy`. Preserve the
   existing package and listing where the report does not require changes.
   Confirm an `en-us` listing and x64 Windows Desktop package. Review the
   certification notes and any other reported failures, then resubmit the initial
   submission once the correction and package qualification are verified.
4. In parallel with certification, associate the Entra tenant and configure the
   release application with the required Partner Center Manager role. Put its
   Tenant ID, Client ID and key value directly into the GitHub environment secrets
   `MS_STORE_TENANT_ID`, `MS_STORE_CLIENT_ID`, and `MS_STORE_CLIENT_SECRET`.
   Do not place credentials in chat, repository files, logs, or workflow inputs.
   Record the key expiry in the owner's credential manager. Login, MFA, tenant
   permissions, and any account-owner declarations may require the owner.
5. Confirm that Partner Center shows a published first application submission,
   that Store installation/update qualification is complete, and that no
   unrelated pending submission will block automation. Then set the repository
   variable `OPENSTUDIO_STORE_ENABLED=true`.
6. Prepare the next actual stable release from a reviewed commit. Review the
   exact Git range and main feature PR, write exact-version release notes, run
   `tools/validate-release-notes.py`, and complete normal release checks. Use a
   new numeric `vX.Y.Z` tag with a higher Store package version. Do not include
   unrelated uncommitted AI work without review.
7. Push that tag, monitor GitHub publication followed by **Submit Microsoft Store
   update**, and inspect Partner Center's final certification/publication result.
   Successful API ingestion alone is not successful publication. Preserve the
   existing Store publishing mode and audience.

## Why a new tag cannot retry the rejected initial submission today

`tools/submit_store_release.py` requires
`lastPublishedApplicationSubmission.id` and clones that published submission.
It also refuses to overwrite unrelated or unmarked pending submissions. With
Store automation enabled before the first publication, a tag may publish the
GitHub release and subsequently fail the Store job. Supporting initial-submission
recovery through the API would be a separate implementation change.

## References

- [Repository Store runbook](release-runbook.md#microsoft-store-release-automation)
- [Microsoft API prerequisites](https://learn.microsoft.com/en-us/windows/uwp/monetize/create-and-manage-submissions-using-windows-store-services)
- [Microsoft privacy-policy fields](https://learn.microsoft.com/en-us/windows/apps/publish/publish-your-app/msix/support-info)
- [GitHub Store environment](https://github.com/sdevil7th/OpenStudio/settings/environments)

Microsoft's documented API prerequisite is an initial submission created through
Partner Center, including age ratings. Requiring an already published submission
is the current OpenStudio implementation's stricter requirement.
