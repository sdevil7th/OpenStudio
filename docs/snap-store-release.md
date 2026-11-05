# Ubuntu App Center / Snap Store release preparation

OpenStudio's publisher account is `sdevil7th` (displayed as Sourav Das). The
`openstudio` name is registered with Snap ID
`Qde7k3B7zO9NGOR8QIyMUWs8l6z6hkZ7`. No revision has been uploaded or released.
The GitHub `snap-store` environment permits only `v*` tags and currently has no
publishing credential. These are setup facts, not Store distribution approval.

The candidate package uses the exact versioned Ubuntu 22.04 DEB payload, plus a
coherent core22 dependency stack. Snapcraft's classic ELF patching handles its
loader paths. Ubuntu's release WebKit ignores `WEBKIT_EXEC_PATH`; a bounded,
same-size prefix relocation points its helpers at the staged `wk` directory.
The installed package must pass main/detached WebView readiness, recovery,
export, updater routing and frozen Support checks before any upload. Source
DEB identity and the final Snap hash are retained in the qualification report.

Support is a separate desktop command, `openstudio.support`. Neither application
is a service or an autostart entry. Collecting evidence remains an explicit
operation requiring OpenStudio closed. Snap installations use Ubuntu App Center
or `snap refresh`; the app never stages or runs an AppImage replacement.

## Remaining owner setup

1. Request and obtain Canonical's classic-confinement approval. Arbitrary native
   plugins, plugin executables and projects may live outside a confined home.
   Approval is a Store decision, not established by the local `--classic` test.
   Record the reviewed decision URL in `OPENSTUDIO_SNAP_CLASSIC_APPROVAL_URL`.
2. On an Ubuntu machine with Snapcraft, export a time-limited credential scoped
   to `openstudio`, channel `stable`, and only the access/push/release ACLs needed
   by this workflow. Complete authentication yourself. Store the exported value
   directly as `SNAPCRAFT_STORE_CREDENTIALS` in the GitHub `snap-store` environment;
   never send it in chat or commit it. Record its expiry privately.
3. Review the installed candidate results. Physical audio/MIDI devices, native
   plugin compatibility, desktop integration, and refresh while an older version
   is running need hardware/desktop testing. Automated checks do not establish
   subjective quality or dropout-free recording.
4. After account access, approval and qualification are complete, set
   `OPENSTUDIO_SNAP_ENABLED=true`. Keep it disabled before those prerequisites.

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
