#include "AIRuntimeSession.h"
#include <utility>

#if JUCE_WINDOWS
 #include <windows.h>
#else
 #include <cerrno>
 #include <fcntl.h>
 #include <sys/file.h>
 #include <sys/stat.h>
 #include <unistd.h>
#endif

namespace AIRuntimeMaintenance
{
juce::File requestFile(const juce::File& root)
{
    return root.getChildFile("ai-maintenance-request.txt");
}

juce::Result requestOnNextLaunch(const juce::File& root, bool compiler)
{
    const auto created = root.createDirectory();
    if (created.failed()) return created;
    juce::InterProcessLock lock("OpenStudio-AI-maintenance-request");
    const juce::InterProcessLock::ScopedLockType scoped(lock);
    if (!scoped.isLocked()) return juce::Result::fail("Could not reserve the AI maintenance request.");
    const auto file = requestFile(root);
    const juce::String kind = compiler ? "compiler" : "stems";
    if (file.existsAsFile())
        return file.loadFileAsString().trim() == kind ? juce::Result::ok()
            : juce::Result::fail("A different AI repair is already scheduled for the next launch.");
    juce::TemporaryFile temporary(file);
    if (!temporary.getFile().replaceWithText(kind) || !temporary.overwriteTargetFileWithTemporary())
        return juce::Result::fail("Could not save the AI maintenance request.");
    return juce::Result::ok();
}

juce::File dataRoot()
{
   #if JUCE_WINDOWS
    const auto local = juce::SystemStats::getEnvironmentVariable("LOCALAPPDATA", {});
    if (local.isNotEmpty()) return juce::File(local).getChildFile("OpenStudio");
    return juce::File::getSpecialLocation(juce::File::userApplicationDataDirectory).getChildFile("OpenStudio");
   #elif JUCE_MAC
    return juce::File::getSpecialLocation(juce::File::userHomeDirectory).getChildFile("Library/Application Support/OpenStudio");
   #elif JUCE_LINUX
    const auto xdg = juce::SystemStats::getEnvironmentVariable("XDG_DATA_HOME", {});
    if (xdg.isNotEmpty()) return juce::File(xdg).getChildFile("OpenStudio");
    return juce::File::getSpecialLocation(juce::File::userHomeDirectory).getChildFile(".local/share/OpenStudio");
   #else
    return juce::File::getSpecialLocation(juce::File::userApplicationDataDirectory).getChildFile("OpenStudio");
   #endif
}

SessionLease::SessionLease(SessionLease&& other) noexcept
    : handle(std::exchange(other.handle, -1)), exclusive(other.exclusive) {}

SessionLease::~SessionLease()
{
    if (!isHeld()) return;
   #if JUCE_WINDOWS
    CloseHandle(reinterpret_cast<HANDLE>(handle));
   #else
    ::close(static_cast<int>(handle));
   #endif
}

juce::Result SessionLease::acquire(const juce::File& root, Mode mode)
{
    if (isHeld()) return juce::Result::fail("This process already owns an AI runtime session.");
    const auto created = root.createDirectory();
    if (created.failed()) return created;
    const auto path = root.getChildFile(".ai-runtime-session.lock").getFullPathName();
    exclusive = mode == Mode::maintenance;
    const auto busy = exclusive
        ? "Close all OpenStudio sessions before starting AI runtime repair."
        : "AI runtime repair is open. Finish or close it before opening OpenStudio.";
   #if JUCE_WINDOWS
    SECURITY_ATTRIBUTES security { sizeof(SECURITY_ATTRIBUTES), nullptr, exclusive ? TRUE : FALSE };
    const auto file = CreateFileW(path.toWideCharPointer(), exclusive ? GENERIC_READ | GENERIC_WRITE : GENERIC_READ,
                                  exclusive ? 0 : FILE_SHARE_READ, &security, OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (file == INVALID_HANDLE_VALUE)
        return juce::Result::fail(GetLastError() == ERROR_SHARING_VIOLATION ? busy : "Could not open the AI runtime session lock.");
    handle = reinterpret_cast<std::intptr_t>(file);
   #else
    // Simple hardware-probe subprocesses also inherit the maintenance lease.
    // Normal workstation descriptors must never escape into plugins or helpers.
    const int fd = ::open(path.toRawUTF8(), O_RDWR | O_CREAT | O_NOFOLLOW | (exclusive ? 0 : O_CLOEXEC), 0600);
    if (fd < 0) return juce::Result::fail("Could not open the AI runtime session lock.");
    struct stat info {};
    if (::fstat(fd, &info) != 0 || !S_ISREG(info.st_mode) || info.st_uid != ::geteuid() || info.st_nlink != 1)
    {
        ::close(fd);
        return juce::Result::fail("Invalid AI runtime session lock.");
    }
    if (::flock(fd, (exclusive ? LOCK_EX : LOCK_SH) | LOCK_NB) != 0)
    {
        const auto error = errno;
        ::close(fd);
        return juce::Result::fail(error == EWOULDBLOCK ? busy : "Could not acquire the AI runtime session lock.");
    }
    handle = fd;
   #endif
    return juce::Result::ok();
}
}
