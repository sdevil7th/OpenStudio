# Microsoft Store activation plan

Status recorded: September 14, 2026.

## Latest account-access checkpoint

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
