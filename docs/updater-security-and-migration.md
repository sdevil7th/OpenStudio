# Signed application updates

Application update manifests now carry an Ed25519 signature. `Source/UpdatePublicKey.h` is the trust anchor embedded in every build. The updater authenticates the exact UTF-8 bytes in `signedPayload`, then uses only those fields for version, channel, architecture, OS requirements, URL, size, and SHA-256. The unsigned outer JSON mirrors the signed payload for older clients. XML appcasts remain available to those older clients; new clients never downgrade to unsigned XML or JSON.

GitHub's stable release manifest is authoritative. The client resolves the latest release through the GitHub API and downloads the manifest by immutable asset ID, avoiding cached redirects to replaced metadata assets. Requests disable caching and include a check nonce. The website JSON is a fallback if GitHub is unavailable, rate-limited, or invalid. A valid stale website can no longer hide a newer GitHub release. After receiving a signed incompatible release, the app keeps the current installation and explains the unmet requirement.

## Activation recorded September 14, 2026

The dedicated signing secret was configured in the OpenStudio repository using GitHub's encrypted-secret API. The five metadata-only corrections for v0.1.01 were published, with package URLs, sizes and hashes preserved. The website's [release-feed deployment](https://github.com/sdevil7th/OpenStudioWebsite/actions/runs/34813672115) succeeded. Both public JSON feeds were independently verified against the embedded public key, and all three public appcasts now contain the reviewed notes. The source changes still need inclusion in a new application release; no new binary or tag was published.

Local evidence is recorded in `output/review/updater-fixed-qualification.json`, `output/review/updater-live-native/result.json`, and `output/review/updater-metadata-repair-0.1.01/live-publication-verification.json`. The final Windows Debug binary passed a real read-only feed check and accepted a signed manifest. Installed upgrades on Windows, macOS, Linux and Microsoft Store are not asserted.

## Signing key

The dedicated updater private key is separate from Windows Authenticode and Apple Developer ID credentials. On this development computer it is encrypted with Windows DPAPI for the current user at `%LOCALAPPDATA%\OpenStudioReleaseKeys\updater-ed25519.dpapi`, outside the repository. The public key is in `Source/UpdatePublicKey.h`.

Store an encrypted backup in the owner's password manager or equivalent recovery system before relying on this key for production. The DPAPI file by itself is not a portable backup: it depends on the Windows user profile. Never commit the seed, print it in logs, or paste it into an issue. Losing the key prevents signing updates accepted by existing clients. Do not regenerate the key for each release; rotation requires a deliberate migration through a release trusted by the old key.

GitHub Actions needs repository secret `OPENSTUDIO_UPDATE_SIGNING_SEED`: the base64 encoding of the dedicated 32-byte Ed25519 seed. `tools/updater_manifest.py` reads it only from the environment, or decrypts the local DPAPI file for local signing. It checks that the private key matches the embedded public key. Publication fails closed if the secret/signature is missing or wrong.

Install the signing dependency with `python -m pip install cryptography==46.0.3`. Generate release metadata from final packages and reviewed exact-version notes, then run:

```powershell
python tools/updater_manifest.py sign --metadata-dir dist/release-metadata
python tools/updater_manifest.py verify --metadata-dir dist/release-metadata
powershell -File tools/prepare-release-publish-assets.ps1
```

The GitHub release workflow and `prepare-public-release.ps1` include signing. Other local metadata generation/preflight commands may produce intermediate unsigned files; they must be signed before the publish preparation gate. The same signed JSON must reach GitHub and the website without reconstructing or stripping its `signedPayload`/`signature` fields. Reformatting the outer JSON is safe if values remain intact. Replacing legacy fields without re-signing is rejected by publishing validation.

This protects against a compromised update website substituting a package. It does not replace platform signing/notarization and does not protect against compromise of the signing key or release CI that can use it. TLS remains required. Signature checks use unmodified Monocypher 4.0.3 sources; Python signing uses `cryptography`.

## Compatibility and installed downloads

Every signed platform entry declares `architectures`. Current release packaging produces Windows x86_64, universal arm64/x86_64 macOS, and Linux x86_64. The macOS baseline is 12.0; Windows is 10. The Ubuntu 24.04 Linux build declares minimum glibc 2.39. Review these contracts when changing build runners or deployment targets. Unknown architectures and unmet OS/libc requirements are blocked before offering a download. This does not promise universal Linux distro compatibility or native ARM Windows/Linux packages.

A staged download persists its relative updater-owned path and signed envelope. Startup reverifies the signature, compatibility, file size and SHA-256 on a background worker before restoring “ready to install,” including when automatic network checks are disabled. Invalid/obsolete tracked packages are discarded without following symlinks or recursively deleting directories. Every installation checks the signature and package again.

Windows launches an interactive installer and uses the saved-project quit path. macOS and Linux now offer **Install update & restart**. This is a user-initiated installation; automatic checks do not silently close the DAW. The frontend saves first, refuses playback/recording, and checks again after preparation. New edits, a changed project, or a declined quit cancel the pending installation.

### macOS and Linux installation transaction

`OpenStudioUpdateInstaller` is a separate native helper copied outside the running app before preparation. It independently verifies the manifest with the compiled public key, channel, increasing version, architecture, minimum OS/glibc, package size and SHA-256. It stages beside the installed application on the same filesystem and persists a transaction journal before replacement. macOS mounts the authenticated DMG read-only, checks bundle ID/executable/version, preserves an existing Apple Team ID when present, and copies with `ditto`. Linux accepts the running user-owned type-2 AppImage only; it does not modify package-manager installations.

The helper refuses symlink installation paths, unsafe ancestor permissions, world/group-writable bundle content, hardlinked files, special files, escaping bundle links, root execution, untrusted locations, insufficient disk space, and concurrent installers. Every updatable app instance holds a shared installation lock until process exit; replacement requires the exclusive lock. Close any older instances from before this locking protocol before upgrading. Protected or root-owned applications require manual installation; a user-owned macOS app can be installed in `~/Applications`.

Preparation does not authorise replacement. The updater must explicitly request an update-specific quit from an already-saved, stopped session; ordinary File > Quit and an unsaved-changes dialog do not carry that consent. The app writes a commit marker only during authorised shutdown, and the helper waits for that exact process to exit. Cancellation interrupts preparation, and a bridge failure requests native cancellation before allowing a retry. A crash, cancelled quit, or OS shutdown during preparation cannot authorise a swap. Shutdown has a two-minute deadline. Both the installed application and staged candidate are fingerprinted again before an atomic exchange (`renamex_np(RENAME_SWAP)` on macOS, `renameat2(RENAME_EXCHANGE)` on Linux). Unsupported filesystems fail closed. The original is retained in a private sibling `.OpenStudio-update-<transaction-id>` directory, and the original install path stays populated across the exchange.

On restart, only the primary frontend's `boot-ready` signal acknowledges success, with the expected signed version and install location. An early exit causes verified rollback and relaunch of the original. If startup takes over two minutes while the process remains alive, the helper retains both versions and reports the missing confirmation; it never kills a possibly edited session or replaces its files underneath it. A process/power interruption leaves the journal and both application entries available for recovery; an incomplete journal does **not** trigger a blind automatic rollback on the next launch.

macOS relaunch uses LaunchServices (`open`), preserving normal system security checks. The updater does not strip quarantine, disable Gatekeeper, install a root helper, or alter certificate trust. Unsigned updates can require macOS user approval; unattended Gatekeeper acceptance is not promised. The packaging script signs the nested helper before the app when an Apple signing identity is configured.

The UI reports a downloaded package path for manual fallback and retained backup paths through transaction status. Recovery files are deliberately retained, including on cancelled preparation, rather than recursively deleted using persisted paths. They consume disk space and can be removed manually after confirming the new version works. Never remove a transaction's backup while recovering an interrupted update. Production manifests do not change user project folders, and the helper never opens or edits projects.

## Existing v0.1.01 users

The published binaries cannot be changed by correcting metadata. Linux v0.1.01 uses its appcast fallback because its JSON platform selector returns `unsupported`; it also fails to grant execute permission to the downloaded AppImage. For the first upgrade, download the new AppImage, use the file manager's executable permission option (or `chmod +x` on that exact file), quit OpenStudio, replace the previous AppImage, and launch the replacement. Do not remove project folders or user settings.

Older Windows/macOS clients can still consume the matching legacy JSON/appcasts. They do not gain signature verification until installing a release containing this implementation. Preserve those feeds during migration.

`tools/prepare-updater-metadata-repair.py --version 0.1.01 --output-dir <directory>` prepares a metadata-only repair using reviewed `docs/releases/0.1.01.md`, checks the published packages against GitHub asset metadata, adds compatibility fields, and signs the result. It never uploads files or replaces binaries. The prepared `output/review/updater-metadata-repair-0.1.01/publish` directory contains the exact proposed GitHub metadata assets. The source notes describe only shipped v0.1.01 behavior; these updater code changes are not claimed to be in that release.

Publish the signed metadata to both existing feed locations before distributing the new updater binary. Unsigned feeds are deliberately rejected by new clients. A real new application release still requires its own version, reviewed release notes, normal packaging gates, and platform installation/relaunch qualification.

## Regression coverage

`OpenStudio --updater-self-test <absolute output directory>` runs headless fixtures with an ephemeral test key. It does not download from the network or launch an installer. The tests cover signature tampering, wrong keys, the RFC 8032 verification vector, architecture/OS/libc eligibility, primary/fallback behavior, staged-download restart, path escape, and package tampering before installation. CI runs this on Windows, macOS and Linux Release builds.

`OpenStudio --updater-feed-self-test <absolute output directory>` performs an explicit read-only live signed-feed check, including in Debug. It writes a report and exits without downloading or launching an application package.

`python -m unittest tests.test_updater_manifest tests.test_release_notes` checks signing, legacy-field consistency, metadata requirements and release-note rejection. Frontend tests cover restored downloads and removal of incompatible offers.

`.github/workflows/updater-installer.yml` builds the actual installer implementation on Ubuntu 24.04, Apple Silicon macOS and Intel macOS with warnings treated as errors. `OpenStudioUpdateInstaller --self-test <absolute output directory>` exercises atomic file/bundle exchange, rollback, tampering, unsafe permissions/links, locks and commit markers. The standalone qualification build additionally signs disposable native process fixtures with an ephemeral test key and runs the helper through successful startup, early-exit rollback, cancelled/no-commit shutdown, late readiness, post-preparation tampering and another running instance. Test keys and shortened timeouts are internal to that qualification build; the production command accepts only a transaction and always uses its embedded public key. The Linux fixture is a native ELF carrying a type-2 marker, not an actual FUSE image; the macOS fixtures are locally created DMGs without downloaded quarantine.

On September 14, 2026, [native installer qualification](https://github.com/sdevil7th/OpenStudio/actions/runs/34819334523) passed all 24 checks on each of Ubuntu 24.04, macOS 15 Apple Silicon, and macOS 15 Intel. Local frontend tests passed 20 checks, Windows native updater fixtures passed 21 checks, and the current frontend production bundle and CMake Debug application built successfully. Browser checks covered both platform dialogs at widths 1280, 640 and 390. The complete record is `output/review/updater-auto-qualification.json`. CI used a qualification-only branch and did not publish a new application release.

These deterministic checks do not establish real old-to-new installation, UAC cancellation/relaunch, Gatekeeper acceptance, Linux desktop/FUSE behavior, Microsoft Store delivery, or project preservation through installed upgrades. Those remain release qualification steps.

September 15 review: corrected browser deadlines for native update operations,
cancellation during preparation, and explicit update-specific quit consent.
The current Windows Debug build passed 22 updater checks and 196 runtime-safety
checks. All 2,299 frontend tests passed, including timeout cancellation, retry,
quit failure, and refusal of update consent for modified/playing/recording
sessions. The frontend production bundle and CMake Debug application built;
no installed upgrade was run in this review.
