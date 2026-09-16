// Included inside UpdateInstaller only in the standalone qualification build.
// The production helper has no injectable key, executable, or timeout options.
template <typename Check>
static void runIntegrationFixtures(const juce::File& root, Check check)
{
    const auto fixture = juce::File::getSpecialLocation(juce::File::currentExecutableFile).getSiblingFile("UpdaterFixture");
    uint8_t seed[32] {}, secret[64] {}, publicKey[32] {};
    for (int i = 0; i < 32; ++i) seed[i] = static_cast<uint8_t>(i + 41);
    crypto_ed25519_key_pair(secret, publicKey, seed);
    const auto publicHex = juce::String::toHexString(publicKey, 32, 0);
    for (const auto* scenario : { "healthy", "exit", "cancel", "no-commit", "late", "tamper", "another-instance" })
    {
        const auto scenarioRoot = root.getChildFile(scenario);
        scenarioRoot.createDirectory();
        const auto target = scenarioRoot.getChildFile(macOS ? "OpenStudio.app" : "OpenStudio.AppImage");
        const auto transaction = scenarioRoot.getChildFile(juce::Uuid().toString());
        transaction.createDirectory();
        writeMarker(transaction, "fixture-behaviour", scenario);
        const auto package = scenarioRoot.getChildFile(macOS ? "fixture.dmg" : "fixture.AppImage");
        bool setup = false;
       #if JUCE_MAC
        auto makeApp = [&](const juce::File& app, const char* version) {
            const auto exe = app.getChildFile("Contents/MacOS/OpenStudio");
            exe.getParentDirectory().createDirectory();
            const auto plist = "<?xml version=\"1.0\" encoding=\"UTF-8\"?><plist version=\"1.0\"><dict>"
                "<key>CFBundleIdentifier</key><string>org.openstudio.updaterfixture</string>"
                "<key>CFBundleExecutable</key><string>OpenStudio</string>"
                "<key>CFBundlePackageType</key><string>APPL</string>"
                "<key>CFBundleShortVersionString</key><string>" + juce::String(version) + "</string></dict></plist>";
            return fixture.copyFileTo(exe) && exe.setExecutePermission(true)
                && app.getChildFile("Contents/Info.plist").replaceWithText(plist);
        };
        const auto contents = scenarioRoot.getChildFile("image-content");
        setup = makeApp(target, "0.0.1") && makeApp(contents.getChildFile("OpenStudio.app"), "999.1.1");
        juce::String output;
        setup = setup && command({ "/usr/bin/hdiutil", "create", "-srcfolder", contents.getFullPathName(), "-format", "UDZO", package.getFullPathName() }, output);
       #else
        setup = fixture.copyFileTo(package) && fixture.copyFileTo(target) && target.setExecutePermission(true);
        // A native ELF with the AppImage type-2 marker exercises the real helper
        // without requiring a FUSE mount. Desktop/FUSE qualification is separate.
        Descriptor fd { ::open(package.getFullPathName().toRawUTF8(), O_WRONLY | O_CLOEXEC) };
        const char marker[] { 'A', 'I', 2 };
        setup = setup && fd.value >= 0 && ::pwrite(fd.value, marker, 3, 8) == 3;
       #endif
        auto payload = juce::JSON::parse(R"({"schemaVersion":1,"version":"999.1.1","channel":"stable","platforms":{}})");
        auto platform = juce::var(new juce::DynamicObject());
        platform.getDynamicObject()->setProperty("architectures", juce::var(juce::Array<juce::var> { UpdateManifest::architecture() }));
        platform.getDynamicObject()->setProperty("size", package.getSize());
        platform.getDynamicObject()->setProperty("sha256", juce::SHA256(package).toHexString());
        payload["platforms"].getDynamicObject()->setProperty(platformName, platform);
        const auto raw = juce::JSON::toString(payload, true);
        uint8_t signature[64] {};
        crypto_ed25519_sign(signature, secret, reinterpret_cast<const uint8_t*>(raw.toRawUTF8()), raw.getNumBytesAsUTF8());
        auto envelope = juce::var(new juce::DynamicObject());
        envelope.getDynamicObject()->setProperty("signedPayload", juce::Base64::toBase64(raw.toRawUTF8(), raw.getNumBytesAsUTF8()));
        envelope.getDynamicObject()->setProperty("signature", juce::Base64::toBase64(signature, 64));
        const auto oldHash = fingerprint(target);
        Descriptor otherInstance;
        if (juce::String(scenario) == "another-instance") otherInstance.value = lockFile(scenarioRoot, ".OpenStudio-running.lock", LOCK_SH);
        const auto owner = setup ? ::fork() : -1;
        if (owner == 0)
        {
            if (otherInstance.value >= 0) ::close(otherInstance.value);
            auto request = juce::var(new juce::DynamicObject());
            request.getDynamicObject()->setProperty("target", target.getFullPathName());
            request.getDynamicObject()->setProperty("package", package.getFullPathName());
            request.getDynamicObject()->setProperty("envelope", envelope);
            request.getDynamicObject()->setProperty("parent", static_cast<int>(::getpid()));
            request.getDynamicObject()->setProperty("currentVersion", OPENSTUDIO_INSTALLER_VERSION);
            writeMarker(transaction, "request.json", juce::JSON::toString(request, true));
            const auto helper = ::fork();
            if (helper == 0) ::_exit(runTransaction(transaction, publicHex, 3, 3));
            if (helper < 0) ::_exit(2);
            for (int i = 0; i < 1200; ++i)
            {
                if (exists(transaction, "result")) ::_exit(2);
                if (exists(transaction, "ready"))
                {
                    if (juce::String(scenario) == "cancel") cancel(transaction);
                    else if (juce::String(scenario) != "no-commit")
                    {
                        if (juce::String(scenario) == "tamper")
                        {
                            const juce::File staged(transaction.getChildFile("backup-path").loadFileAsString());
                            const auto file = macOS ? staged.getChildFile("Contents/Info.plist") : staged;
                            file.appendText("changed after verification");
                        }
                        commit(transaction);
                    }
                    ::_exit(0);
                }
                juce::Thread::sleep(100);
            }
            cancel(transaction); ::_exit(2);
        }
        bool finished = false;
        if (owner > 0)
        {
            for (int i = 0; i < 1500; ++i)
            {
                int status = 0; ::waitpid(owner, &status, WNOHANG);
                if (exists(transaction, "result")) { finished = true; break; }
                juce::Thread::sleep(100);
            }
        }
        const auto result = transaction.getChildFile("result").loadFileAsString();
        const auto mode = juce::String(scenario);
        bool okay = setup && finished;
        if (mode == "healthy") okay = okay && result.startsWith("Update installed") && fingerprint(target) != oldHash;
        else if (mode == "late") okay = okay && result.contains("left running") && fingerprint(target) != oldHash;
        else if (mode == "exit") okay = okay && result.contains("previous version was restored") && fingerprint(target) == oldHash;
        else if (mode == "cancel") okay = okay && result.contains("cancelled") && fingerprint(target) == oldHash;
        else if (mode == "no-commit") okay = okay && result.contains("authorised shutdown") && fingerprint(target) == oldHash;
        else if (mode == "tamper") okay = okay && result.contains("changed after preparation") && fingerprint(target) == oldHash;
        else okay = okay && result.contains("Another OpenStudio instance") && fingerprint(target) == oldHash;
        const auto label = "helper_transaction_" + mode;
        check(label.toRawUTF8(), okay);
        if (!okay) juce::Logger::outputDebugString(label + ": " + result);
    }
    crypto_wipe(secret, sizeof(secret));
}
