#include "UpdateManifest.h"
#include "UpdatePublicKey.h"
#include <monocypher-ed25519.h>
#if JUCE_LINUX && defined(__GLIBC__)
 #include <gnu/libc-version.h>
#endif

namespace UpdateManifest
{
juce::String publicKey() { return openStudioUpdatePublicKey; }

juce::var verify(const juce::var& envelope, const juce::String& publicKeyHex, juce::String& error)
{
    juce::MemoryOutputStream payload, signature;
    juce::MemoryBlock key;
    const auto encoded = envelope["signedPayload"].toString();
    const auto sig = envelope["signature"].toString();
    if (publicKeyHex.length() != 64 || !publicKeyHex.containsOnly("0123456789abcdefABCDEF"))
        error = "This build has no trusted update signing key.";
    else if (encoded.isEmpty() || encoded.length() > 1500000 || sig.length() != 88
             || !juce::Base64::convertFromBase64(payload, encoded)
             || !juce::Base64::convertFromBase64(signature, sig) || signature.getDataSize() != 64)
        error = "The update manifest is missing a valid publisher signature.";
    else
    {
        key.loadFromHexString(publicKeyHex);
        if (key.getSize() != 32 || crypto_ed25519_check(
                static_cast<const uint8_t*>(signature.getData()), static_cast<const uint8_t*>(key.getData()),
                static_cast<const uint8_t*>(payload.getData()), payload.getDataSize()) != 0)
            error = "The update manifest failed publisher signature verification.";
        else
        {
            auto parsed = juce::JSON::parse(payload.toUTF8());
            if (parsed.isObject() && parsed["schemaVersion"] == juce::var(1)) return parsed;
            error = "The signed update manifest format is not supported.";
        }
    }
    return {};
}

bool numericVersion(const juce::String& value)
{
    if (value.isEmpty() || value.length() > 48 || !value.containsOnly("0123456789.")) return false;
    const auto parts = juce::StringArray::fromTokens(value, ".", "");
    if (parts.size() < 1 || parts.size() > 4) return false;
    for (const auto& part : parts) if (part.isEmpty() || part.length() > 9) return false;
    return true;
}

int compareVersions(const juce::String& left, const juce::String& right)
{
    const auto a = juce::StringArray::fromTokens(left, ".", "");
    const auto b = juce::StringArray::fromTokens(right, ".", "");
    for (int i = 0; i < juce::jmax(a.size(), b.size()); ++i)
    {
        const auto av = i < a.size() ? a[i].getLargeIntValue() : 0;
        const auto bv = i < b.size() ? b[i].getLargeIntValue() : 0;
        if (av != bv) return av < bv ? -1 : 1;
    }
    return 0;
}

juce::String architecture()
{
   #if defined(__aarch64__) || defined(_M_ARM64)
    return "arm64";
   #elif defined(__x86_64__) || defined(_M_X64)
    return "x86_64";
   #else
    return "unsupported";
   #endif
}

juce::String systemVersion()
{
    // JUCE returns e.g. "macOS 15.6.0" or "Windows 11". Linux uses
    // minimumGlibcVersion instead of comparing unrelated distro versions.
    return juce::SystemStats::getOperatingSystemName().retainCharacters("0123456789.");
}

juce::String libcVersion()
{
   #if JUCE_LINUX && defined(__GLIBC__)
    return gnu_get_libc_version();
   #else
    return {};
   #endif
}

bool compatible(const juce::var& platform, const juce::String& arch,
                const juce::String& osVersion, const juce::String& glibc, juce::String& error)
{
    const auto architectures = platform["architectures"];
    if (!architectures.isArray() || !architectures.getArray()->contains(juce::var(arch)))
        error = "This update does not support the application's CPU architecture (" + arch + ").";
    else
    {
        for (const auto& requirement : { std::pair<juce::String, juce::String>("minimumSystemVersion", osVersion),
                                         std::pair<juce::String, juce::String>("minimumGlibcVersion", glibc) })
        {
            const auto minimum = platform[juce::Identifier(requirement.first)].toString();
            if (minimum.isNotEmpty() && (!numericVersion(minimum) || !numericVersion(requirement.second)
                                        || compareVersions(requirement.second, minimum) < 0))
            {
                const auto label = requirement.first == "minimumGlibcVersion" ? "glibc " : "OS version ";
                error = "This update requires " + juce::String(label) + minimum + ". Your current installation has been kept.";
                return false;
            }
        }
        return true;
    }
    return false;
}
}
