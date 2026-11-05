# Ubuntu App Center / Snap Store release preparation

OpenStudio's publisher account is `sdevil7th` (displayed as Sourav Das). The
`openstudio` name is registered with Snap ID
`Qde7k3B7zO9NGOR8QIyMUWs8l6z6hkZ7`. No revision has been uploaded or released.
The GitHub `snap-store` environment permits only `v*` tags. A credential scoped
to `openstudio`, stable, access/push/release is configured with a requested expiry
of 3 February 2027. Renew by 2 February: Snapcraft 8.14 interprets expiry input
using local time unless the command runs with `TZ=UTC`. Read-only account and
registered-snap checks passed. The temporary export
was removed after encrypted GitHub storage. These facts do not establish Store
distribution approval.

Both repository delivery switches, `OPENSTUDIO_STORE_ENABLED` and
`OPENSTUDIO_SNAP_ENABLED`, are enabled so the next release tag requires both
Store preflights. Missing Snap qualification or Canonical approval blocks GitHub
publication and both submissions. No tag or release was created during setup.

The candidate package uses the exact versioned Ubuntu 22.04 DEB payload, plus a
coherent core22 dependency stack. Snapcraft's classic ELF patching handles its
loader paths. Ubuntu's release WebKit ignores `WEBKIT_EXEC_PATH`; a bounded,
same-size prefix relocation points its helpers at the staged `wk` directory.
Perform the schema and WebKit transformations during `override-build`:
Snapcraft explicitly disables `enable-patchelf` for an `override-prime` part.
The installed package must pass main/detached WebView readiness, recovery,
export, updater routing and frozen Support checks before any upload. Source
DEB identity and the final Snap hash are retained in the qualification report.

Support is a separate desktop command, `openstudio.support`. Neither application
is a service or an autostart entry. Collecting evidence remains an explicit
operation requiring OpenStudio closed. Snap installations use Ubuntu App Center
or `snap refresh`; the app never stages or runs an AppImage replacement.

## Listing and branding

`packaging/snap/listing.json` is the reviewed source for the Store title,
summary, description, search keywords, Music & Audio category, license and
public support links. The project generator uses the same text and links in
the package recipe. The icon is the approved 512 px export at
`frontend/public/icon.png`; Linux launchers use the existing 256 px export.

Store-side application is tracked separately from package preparation. The
approved icon was saved through the binary-metadata API and its returned SHA-256
matches `32ee0324c1fc4d30d1451bee95af868040e6775217b3ca24f2fa994d0ab57297`.
No application revision was uploaded or released. The dashboard requires a first
revision before exposing its listing editor. The text API currently rejects
nonempty summary and description fields as blank, including Canonical's own
Dashboard PUT format. The owner chose to revisit text after package qualification;
title, description, keywords, category, license and public links remain staged.
Do not record text as Store-applied until readback proves it. Preserve other
media and listing settings. Real Linux candidate screenshots remain required for the gallery;
do not use captures of another platform as Linux screenshots.

## Desktop diagnostic hold

Three Snap window-harness timeouts were paused with
`OPENSTUDIO_SNAP_WINDOW_TESTS_PAUSED` until the owner provided a Linux desktop.
The explicit desktop trace located a browser-child crash in Mesa's software
driver while reading ELF notes. Snapcraft 8.14.5 bundles patchelf 0.9: its fixups
moved valid note sections while leaving stale runtime note segments. This matches
[upstream issue 217](https://github.com/NixOS/patchelf/issues/217).

The recipe builds checksum-pinned patchelf 0.18.0 as a build-only tool, excludes it
from the app, and invokes Canonical's same dependency resolver with that patcher.
Its managed build must be Ubuntu 22.04. Runtime note mappings and original GNU
build IDs must survive every fixup, then the installed package is audited again
before any app window opens. GIO module discovery is restricted to the matching
packaged directory. The browser-stack audit accepts base-identical GLib from
core22; GTK/WebKit/Soup must come from the app Snap and host GLib is rejected.

A corrected private Mesa copy reached frontend `boot-ready` on the Linux desktop.
A real relocation fixture passes metadata validation and executes after the new
patcher; the bundled 0.9 control fails the new audit. These are diagnostic results,
not installed-package qualification or hardware GPU/audio qualification. Resume
automatic window checks for this concrete packaging correction; full installed
main/popout/recovery/export/Support/updater checks are still required.

Installed export, explicitly opened Support and updater checks run independently.
A diagnostic Snap is retained even when qualification fails. If the pause is
enabled again it produces failed qualification, never a release-ready candidate;
both Store publication paths remain gated.

The Verify workflow's explicit `snap_source_run` input builds only a diagnostic
Snap from `candidate-linux-x64` in that selected prior Verify run. This avoids
rebuilding unchanged application code for packaging diagnosis. The package stays
unqualified even if its diagnostic checks succeed. Release does not set this
input and always uses its own build artifacts. Resume automatic window checks
after the desktop investigation; complete qualification is still required.

For future credential exports, set `TZ=UTC` for the export command only and
verify the resulting credential's actual expiry before using it. A short-lived
listing credential has access/push/update permissions and no release permission;
it must not replace the release credential in GitHub. Never print exported
credentials or include them in reports.

## Remaining owner setup

1. Request and obtain Canonical's classic-confinement approval. Arbitrary native
   plugins, plugin executables and projects may live outside a confined home.
   Approval is a Store decision, not established by the local `--classic` test.
   Confirm eligibility with Canonical rather than treating arbitrary file access
   as sufficient: its [review process](https://forum.snapcraft.io/t/process-for-reviewing-classic-confinement-snaps/1460/)
   requires a supported category or further reviewer/architect consideration.
   A strict-confinement interface test has not been performed; do not claim it
   has, or promise that a DAW will receive classic approval. Any strict-package
   alternative needs separate plugin, device and performance qualification.
   Record the reviewed decision URL in `OPENSTUDIO_SNAP_CLASSIC_APPROVAL_URL`.
2. Keep `SNAPCRAFT_STORE_CREDENTIALS` in the GitHub `snap-store` environment
   current. Renew the scoped credential before its expiry; never send it in chat
   or commit it. Account authentication remains an owner-operated step.
3. Review the installed candidate results. Physical audio/MIDI devices, native
   plugin compatibility, desktop integration, and refresh while an older version
   is running need hardware/desktop testing. Automated checks do not establish
   subjective quality or dropout-free recording.
4. Keep both delivery switches enabled for releases intended for both Stores.
   Before creating a tag, require successful qualification and a real approval
   record. Do not disable a delivery path to bypass a failed preflight.

## Tag-triggered flow

After the release PR is merged, an owner-authorized `v0.1.09` tag triggers the
existing Release workflow. If Snap delivery is enabled, its dependencies are:

`build-linux -> qualify-snap -> preflight-snap -> publish -> submit-snap`.

The Microsoft Store chain remains
`build-windows -> preflight-store -> publish -> submit-store`.

Both enabled Store preflights must succeed before GitHub publication. A missing
credential, approval record, artifact identity, or prerequisite stops the chain.
Snap preflight only authenticates and reads status. Submission revalidates the
qualified bytes, then calls `snapcraft upload --release=stable` once. No automatic
retry follows an ambiguous upload; inspect Store revisions first. CLI success
does not prove final availability or installed update delivery.

Do not create a release tag or dispatch Release during preparation. Nothing in
this document authorizes upload, publication or a confinement-review message.

References: [registration](https://ubuntu.com/docs/snapcraft/latest/how-to/publishing/register-a-snap/),
[authentication](https://ubuntu.com/docs/snapcraft/latest/how-to/publishing/authenticate/),
[classic confinement](https://ubuntu.com/docs/snapcraft/latest/how-to/crafting/enable-classic-confinement/).
