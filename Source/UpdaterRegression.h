#pragma once
#include "AppUpdater.h"
#include "UpdateManifest.h"
#include "UpdateInstaller.h"
#include "RuntimeLocation.h"
#include <monocypher-ed25519.h>
#if JUCE_MAC || JUCE_LINUX
 #include <sys/stat.h>
#endif

// Headless fixtures use an ephemeral test key. No network or installer launch.
class UpdaterRegression
{
public:
    static juce::var checkPublishedFeed(const juce::File& directory)
    {
        AppUpdater updater(directory);
        return updater.performUpdateCheck(); // Read-only: never download or launch a package.
    }

    static juce::var run(const juce::File& directory)
    {
        juce::Array<juce::var> checks;
        auto check = [&](const char* name, bool pass) {
            auto* item = new juce::DynamicObject();
            item->setProperty("name", name); item->setProperty("pass", pass); checks.add(juce::var(item));
        };
       #if JUCE_MAC || JUCE_LINUX
        // The report may be under /tmp, which is deliberately not trusted for
        // executable staging. Exercise fresh profile creation under the user's
        // trusted home instead, without touching the actual application profile.
        const auto privateRoot = juce::File::getSpecialLocation(juce::File::userHomeDirectory)
            .getChildFile(".openstudio-updater-regression-" + juce::Uuid().toString());
        const bool rootCreated = !privateRoot.exists()
            && UpdateInstaller::ensurePrivateDirectory(privateRoot);
        check("private_profile_fixture_created", rootCreated);
        if (rootCreated)
        {
            struct ScopedTestUmask
            {
                explicit ScopedTestUmask(mode_t value) : previous(::umask(value)) {}
                ~ScopedTestUmask() { ::umask(previous); }
                mode_t previous;
            };
            auto modeOf = [](const juce::File& path) -> mode_t {
                struct stat info {};
                return ::lstat(path.getFullPathName().toRawUTF8(), &info) == 0
                    ? static_cast<mode_t>(info.st_mode & 0777) : static_cast<mode_t>(0);
            };
            for (const auto mask : { static_cast<mode_t>(0002), static_cast<mode_t>(0077) })
            {
                const ScopedTestUmask scopedMask(mask);
                const auto profile = privateRoot.getChildFile("profile-" + juce::String(static_cast<int>(mask)));
                AppUpdater fresh(profile);
                const bool packageManaged = OpenStudioRuntime::nativePackageFormat().isNotEmpty();
                check(((packageManaged ? "native_package_constructor_skips_profile_" : "constructor_creates_private_profile_")
                       + juce::String(static_cast<int>(mask))).toRawUTF8(),
                      packageManaged ? !profile.exists() : modeOf(profile) == 0700);
                fresh.persistedState = juce::JSON::parse(R"({"lastSeenVersion":"999.1.1"})");
                const auto downloads = profile.getChildFile("updates");
                const auto stagedFolder = downloads.getChildFile(juce::Uuid().toString());
                check(("persist_then_stage_private_profile_" + juce::String(static_cast<int>(mask))).toRawUTF8(),
                      fresh.savePersistedState()
                      && juce::JSON::parse(profile.getChildFile("updater-state.json"))["lastSeenVersion"] == "999.1.1"
                      && UpdateInstaller::ensurePrivateDirectory(stagedFolder)
                      && modeOf(profile) == 0700 && modeOf(downloads) == 0700 && modeOf(stagedFolder) == 0700);
                // The profile may be removed between construction and a later
                // check; persistence must not recreate it with ambient 0775.
                const bool removed = profile.deleteRecursively();
                check(("persist_recreates_private_profile_" + juce::String(static_cast<int>(mask))).toRawUTF8(),
                      removed && fresh.savePersistedState() && modeOf(profile) == 0700);
            }
            const auto existingProfile = privateRoot.getChildFile("existing-insecure-profile");
            const bool existingCreated = UpdateInstaller::ensurePrivateDirectory(existingProfile)
                && ::chmod(existingProfile.getFullPathName().toRawUTF8(), 0775) == 0;
            AppUpdater existing(existingProfile);
            existing.persistedState = juce::JSON::parse(R"({"lastSeenVersion":"999.1.1"})");
            check("existing_profile_metadata_preserved_but_staging_rejected", existingCreated
                  && existing.savePersistedState() && modeOf(existingProfile) == 0775
                  && !UpdateInstaller::ensurePrivateDirectory(existingProfile.getChildFile("updates"))
                  && !existingProfile.getChildFile("updates").exists());
            check("private_profile_fixture_removed", privateRoot.deleteRecursively());
        }
       #endif
        uint8_t seed[32] {}, secret[64] {}, key[32] {};
        for (int i = 0; i < 32; ++i) seed[i] = static_cast<uint8_t>(i + 1);
        crypto_ed25519_key_pair(secret, key, seed);
        const auto publicHex = juce::String::toHexString(key, 32, 0);
        auto envelopeFor = [&](const juce::var& payload) {
            const auto raw = juce::JSON::toString(payload, true);
            uint8_t signature[64] {};
            crypto_ed25519_sign(signature, secret, reinterpret_cast<const uint8_t*>(raw.toRawUTF8()), raw.getNumBytesAsUTF8());
            auto envelope = payload.clone();
            envelope.getDynamicObject()->setProperty("signedPayload", juce::Base64::toBase64(raw.toRawUTF8(), raw.getNumBytesAsUTF8()));
            envelope.getDynamicObject()->setProperty("signature", juce::Base64::toBase64(signature, 64));
            return envelope;
        };
        AppUpdater updater(directory);
        updater.trustedPublicKey = publicHex;
        const auto root = directory.getChildFile("updates");
        const auto folder = root.getChildFile(juce::Uuid().toString());
        folder.createDirectory();
        const auto suffix = AppUpdater::getPlatformKey() == "windows" ? ".exe" : AppUpdater::getPlatformKey() == "macos" ? ".dmg" : ".AppImage";
        const auto file = folder.getChildFile("fixture" + juce::String(suffix));
        file.replaceWithText("not an executable; updater test data only");
        auto payload = juce::JSON::parse(R"({"schemaVersion":1,"version":"999.1.1","channel":"stable","platforms":{}})");
        auto* platform = new juce::DynamicObject();
        platform->setProperty("architectures", juce::var(juce::Array<juce::var> { juce::var(UpdateManifest::architecture()) }));
        platform->setProperty("url", "https://example.invalid/" + file.getFileName());
        platform->setProperty("sha256", juce::SHA256(file).toHexString());
        platform->setProperty("size", file.getSize());
        payload["platforms"].getDynamicObject()->setProperty(AppUpdater::getPlatformKey(), juce::var(platform));
        auto envelope = envelopeFor(payload);
        juce::String error;
        check("accepts_ed25519_signed_payload", UpdateManifest::verify(envelope, publicHex, error).isObject());
        check("rejects_unsigned_manifest", !UpdateManifest::verify(payload, publicHex, error).isObject());
        check("rejects_wrong_signing_key", !UpdateManifest::verify(envelope, juce::String::repeatedString("01", 32), error).isObject());
        auto changed = envelope.clone();
        changed.getDynamicObject()->setProperty("signedPayload", juce::Base64::toBase64("modified", 8));
        check("rejects_payload_tampering", !UpdateManifest::verify(changed, publicHex, error).isObject());
        changed = envelope.clone(); changed.getDynamicObject()->setProperty("version", "0.0.0");
        check("unsigned_outer_fields_cannot_override_payload", UpdateManifest::verify(changed, publicHex, error)["version"] == payload["version"]);
        changed = envelope.clone(); changed.getDynamicObject()->setProperty("signature", "bad");
        check("rejects_truncated_signature", !UpdateManifest::verify(changed, publicHex, error).isObject());

        auto config = juce::JSON::parse(R"({"architectures":["arm64","x86_64"],"minimumSystemVersion":"12.0"})");
        check("universal_macos_accepts_both_architectures", UpdateManifest::compatible(config, "arm64", "12.0", "", error)
            && UpdateManifest::compatible(config, "x86_64", "15.0", "", error));
        check("rejects_older_macos", !UpdateManifest::compatible(config, "arm64", "11.9", "", error));
        check("rejects_unknown_architecture", !UpdateManifest::compatible(config, "riscv64", "15.0", "", error));
        config = juce::JSON::parse(R"({"architectures":["x86_64"],"minimumGlibcVersion":"2.39"})");
        check("linux_glibc_compatibility", UpdateManifest::compatible(config, "x86_64", "", "2.39", error)
            && !UpdateManifest::compatible(config, "x86_64", "", "2.38", error)
            && !UpdateManifest::compatible(config, "x86_64", "", "", error));
        check("rejects_undeclared_architectures", !UpdateManifest::compatible(juce::var(), "x86_64", "10", "", error));

        int githubCalls = 0, websiteCalls = 0;
        updater.feedReader = [&](const juce::String& url) {
            if (url.startsWith("https://github.com/")) { ++githubCalls; return juce::JSON::toString(envelope); }
            ++websiteCalls; return juce::JSON::toString(payload);
        };
        auto status = updater.performUpdateCheck();
        check("authoritative_feed_precedes_stale_website", status["status"] == "update-available" && githubCalls == 1 && websiteCalls == 0);
        updater.feedReader = [&](const juce::String& url) {
            return url.startsWith("https://github.com/") ? juce::String() : juce::JSON::toString(envelope);
        };
        check("signed_website_fallback_when_github_unavailable", updater.performUpdateCheck()["status"] == "update-available");
        updater.feedReader = [&](const juce::String&) { return juce::JSON::toString(payload); };
        check("no_unsigned_fallback", updater.performUpdateCheck()["status"] == "error");
        auto incompatible = payload.clone();
        incompatible["platforms"][juce::Identifier(AppUpdater::getPlatformKey())].getDynamicObject()->setProperty("architectures", juce::var(juce::Array<juce::var> { "riscv64" }));
        check("incompatible_feed_never_offers_download", updater.statusFromEnvelope(envelopeFor(incompatible))["status"] == "incompatible");

        auto* staged = new juce::DynamicObject();
        staged->setProperty("relativePath", file.getRelativePathFrom(root));
        staged->setProperty("signedEnvelope", envelope);
        updater.persistedState.getDynamicObject()->setProperty("stagedDownload", juce::var(staged));
        check("persists_staged_download", updater.savePersistedState());
        AppUpdater reopened(directory);
        reopened.trustedPublicKey = publicHex;
        check("restart_restores_and_reverifies_download", reopened.restoreDownload()["status"] == "download-ready"
            && reopened.downloadedInstaller == file);
        reopened.cancelDownload();
        check("cancelled_install_never_launches_verified_package", reopened.performInstall()["status"] == "cancelled");
        reopened.cancelRequested = false;
        file.appendText("tampered");
        check("install_rechecks_package_before_launch", reopened.performInstall()["status"] == "error");
        check("restart_discards_corrupt_staged_package", !reopened.restoreDownload().isObject() && !file.existsAsFile());
        check("rejects_staged_path_escape", AppUpdater::stagedFile(root, "../outside.exe") == juce::File()
            && AppUpdater::stagedFile(root, "C:/outside.exe") == juce::File()
            && AppUpdater::stagedFile(root, juce::Uuid().toString() + "/../outside.exe") == juce::File());

        // RFC 8032 test vector 1 independently checks the library's wire format.
        juce::MemoryBlock rfcKey, rfcSig;
        rfcKey.loadFromHexString("d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a");
        rfcSig.loadFromHexString("e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b");
        check("rfc8032_ed25519_verification", crypto_ed25519_check(static_cast<const uint8_t*>(rfcSig.getData()),
            static_cast<const uint8_t*>(rfcKey.getData()), nullptr, 0) == 0);
        const auto publishedFixture = directory.getChildFile("release-envelope.json");
        if (publishedFixture.existsAsFile())
            check("python_signed_release_verifies_in_native_client", UpdateManifest::verify(
                juce::JSON::parse(publishedFixture.loadFileAsString()), UpdateManifest::publicKey(), error).isObject());
        crypto_wipe(secret, sizeof(secret));
        bool pass = true;
        for (const auto& item : checks) pass = pass && static_cast<bool>(item["pass"]);
        auto* report = new juce::DynamicObject(); report->setProperty("pass", pass); report->setProperty("checks", checks);
        report->setProperty("installedUpgrade", "not_asserted");
        return juce::var(report);
    }
};
