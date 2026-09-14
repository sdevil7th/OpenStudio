#include "UpdateInstaller.h"
#include "UpdateManifest.h"
#include <juce_cryptography/juce_cryptography.h>
#include <filesystem>
#include <vector>
#include <stdexcept>
#if defined(OPENSTUDIO_INSTALLER_TEST_FIXTURES)
 #include <monocypher-ed25519.h>
#endif
#if JUCE_MAC || JUCE_LINUX
 #include <fcntl.h>
 #include <signal.h>
 #include <spawn.h>
 #include <sys/file.h>
 #include <sys/stat.h>
 #include <sys/wait.h>
 #include <unistd.h>
 #if JUCE_LINUX
  #include <sys/syscall.h>
 #else
  #include <stdio.h>
  #include <crt_externs.h>
 #endif
#endif

namespace UpdateInstaller
{
#if JUCE_MAC || JUCE_LINUX
namespace
{
namespace fs = std::filesystem;
constexpr int preparationSeconds = 180;
constexpr int shutdownSeconds = 120;
constexpr int startupSeconds = 120;
#if JUCE_MAC
constexpr bool macOS = true;
#else
constexpr bool macOS = false;
#endif
const char* platformName = macOS ? "macos" : "linux";
int runningLock = -1; // Held until process exit, including audio/browser teardown.
juce::String launchReceipt;

struct Descriptor
{
    int value = -1;
    ~Descriptor() { if (value >= 0) ::close(value); }
};

bool safePath(const juce::File& file, bool directory)
{
    struct stat info {};
    if (::lstat(file.getFullPathName().toRawUTF8(), &info) != 0
        || (directory ? !S_ISDIR(info.st_mode) : !S_ISREG(info.st_mode))
        || info.st_uid != ::getuid() || (info.st_mode & 0022) != 0) return false;
    auto parent = file.getParentDirectory();
    for (;;)
    {
        if (::lstat(parent.getFullPathName().toRawUTF8(), &info) != 0 || !S_ISDIR(info.st_mode)
            || (info.st_uid != 0 && info.st_uid != ::getuid())
            || (info.st_mode & 0002) != 0
            || (info.st_uid != 0 && (info.st_mode & 0020) != 0)) return false;
        const auto next = parent.getParentDirectory();
        if (next == parent) break;
        parent = next;
    }
    return ::geteuid() == ::getuid() && ::getuid() != 0;
}

int lockFile(const juce::File& parent, const char* name, int operation)
{
    const auto path = parent.getChildFile(name);
    const auto fd = ::open(path.getFullPathName().toRawUTF8(), O_RDWR | O_CREAT | O_NOFOLLOW | O_CLOEXEC, 0600);
    struct stat info {};
    if (fd < 0) return -1;
    if (::fstat(fd, &info) != 0 || !S_ISREG(info.st_mode) || info.st_uid != ::getuid()
        || info.st_nlink != 1 || (info.st_mode & 0077) != 0 || ::flock(fd, operation | LOCK_NB) != 0)
    { ::close(fd); return -1; }
    return fd;
}

bool writeMarker(const juce::File& folder, const char* name, const juce::String& text)
{
    const auto path = folder.getChildFile(name);
    Descriptor fd { ::open(path.getFullPathName().toRawUTF8(), O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600) };
    if (fd.value < 0) return false;
    const auto bytes = text.getNumBytesAsUTF8();
    return ::write(fd.value, text.toRawUTF8(), bytes) == static_cast<ssize_t>(bytes) && ::fsync(fd.value) == 0;
}

bool exists(const juce::File& folder, const char* name) { return folder.getChildFile(name).existsAsFile(); }

#if JUCE_MAC
bool command(const juce::StringArray& args, juce::String& output)
{
    juce::ChildProcess child;
    if (!child.start(args, juce::ChildProcess::wantStdOut | juce::ChildProcess::wantStdErr)) return false;
    if (!child.waitForProcessToFinish(60000)) { child.kill(); output = "System command timed out."; return false; }
    output = child.readAllProcessOutput().substring(0, 8192);
    return child.getExitCode() == 0;
}
#endif

// No shell interpretation. exec children cannot inherit updater locks. The
// AppImage's old mount and loader environment must not leak into the new image.
pid_t launch(const juce::File& executable, const juce::StringArray& args,
             const juce::File& receipt = {})
{
    juce::StringArray strings { executable.getFullPathName() };
    strings.addArray(args);
    std::vector<char*> argv;
    for (auto& str : strings) argv.push_back(const_cast<char*>(str.toRawUTF8()));
    argv.push_back(nullptr);
    juce::StringArray environment;
   #if JUCE_MAC
    auto** inherited = *_NSGetEnviron();
   #else
    auto** inherited = environ;
   #endif
    const juce::StringArray removed { "APPIMAGE", "APPDIR", "ARGV0", "OWD", "LD_LIBRARY_PATH", "LD_PRELOAD",
                                     "DYLD_LIBRARY_PATH", "DYLD_INSERT_LIBRARIES", "OPENSTUDIO_UPDATE_RECEIPT" };
    for (auto** item = inherited; *item != nullptr; ++item)
    {
        const juce::String value(*item);
        if (!removed.contains(value.upToFirstOccurrenceOf("=", false, false))) environment.add(value);
    }
    if (receipt != juce::File()) environment.add("OPENSTUDIO_UPDATE_RECEIPT=" + receipt.getFullPathName());
    std::vector<char*> env;
    for (auto& str : environment) env.push_back(const_cast<char*>(str.toRawUTF8()));
    env.push_back(nullptr);
    posix_spawn_file_actions_t actions;
    ::posix_spawn_file_actions_init(&actions);
    for (int fd = 0; fd < 3; ++fd) ::posix_spawn_file_actions_addopen(&actions, fd, "/dev/null", O_RDWR, 0);
    posix_spawnattr_t attributes;
    ::posix_spawnattr_init(&attributes);
    ::posix_spawnattr_setflags(&attributes, POSIX_SPAWN_SETPGROUP);
    ::posix_spawnattr_setpgroup(&attributes, 0);
    pid_t pid = -1;
    const auto result = ::posix_spawn(&pid, argv[0], &actions, &attributes, argv.data(), env.data());
    ::posix_spawnattr_destroy(&attributes);
    ::posix_spawn_file_actions_destroy(&actions);
    return result == 0 ? pid : -1;
}

bool exchange(const juce::File& a, const juce::File& b)
{
   #if JUCE_MAC
    return ::renamex_np(a.getFullPathName().toRawUTF8(), b.getFullPathName().toRawUTF8(), RENAME_SWAP) == 0;
   #else
    return ::syscall(SYS_renameat2, AT_FDCWD, a.getFullPathName().toRawUTF8(),
                     AT_FDCWD, b.getFullPathName().toRawUTF8(), 2 /* RENAME_EXCHANGE */) == 0;
   #endif
}

bool syncDirectory(const juce::File& dir)
{
    Descriptor fd { ::open(dir.getFullPathName().toRawUTF8(), O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC) };
    return fd.value >= 0 && ::fsync(fd.value) == 0;
}

juce::String fingerprint(const juce::File& file, bool syncFiles = false)
{
    // Hash the entire bundle, including relative symlink targets. Do not follow
    // symlinks or permit one to escape the authenticated bundle.
    try
    {
        const fs::path root(file.getFullPathName().toStdString());
        juce::StringArray entries;
        auto add = [&](const fs::path& p) {
            const auto status = fs::symlink_status(p);
            const auto relative = p.lexically_relative(root).generic_string();
            if (fs::is_symlink(status))
            {
                const auto link = fs::read_symlink(p);
                const auto resolved = fs::canonical(p).lexically_relative(fs::canonical(root));
                if (link.is_absolute() || resolved.empty() || *resolved.begin() == "..") throw std::runtime_error("Unsafe bundle link");
                entries.add(juce::String(relative) + "|link|" + juce::String(link.generic_string()));
            }
            else if (fs::is_regular_file(status))
            {
                struct stat info {};
                if (::lstat(p.c_str(), &info) != 0 || info.st_nlink != 1 || (info.st_mode & 06000) != 0)
                    throw std::runtime_error("Unsafe file");
                const juce::File item(juce::String(p.string()));
                if (syncFiles)
                {
                    Descriptor fd { ::open(p.c_str(), O_RDONLY | O_NOFOLLOW | O_CLOEXEC) };
                    if (fd.value < 0 || ::fsync(fd.value) != 0) throw std::runtime_error("Disk sync failed");
                }
                entries.add(juce::String(relative) + "|" + juce::String(static_cast<int>(info.st_mode & 0777)) + "|" + juce::SHA256(item).toHexString());
            }
            else if (fs::is_directory(status)) entries.add(juce::String(relative) + "|directory");
            else throw std::runtime_error("Unexpected file type");
        };
        add(root);
        if (fs::is_directory(root))
        {
            for (const auto& entry : fs::recursive_directory_iterator(root)) add(entry.path());
            if (syncFiles)
            {
                for (const auto& entry : fs::recursive_directory_iterator(root))
                    if (fs::is_directory(entry.symlink_status()) && !syncDirectory(juce::File(juce::String(entry.path().string())))) return {};
                if (!syncDirectory(file)) return {};
            }
        }
        entries.sort(false);
        const auto text = entries.joinIntoString("\n");
        return juce::SHA256(text.toRawUTF8(), text.getNumBytesAsUTF8()).toHexString();
    }
    catch (...) { return {}; }
}

bool swapVerified(const juce::File& target, const juce::File& candidate,
                  const juce::String& oldHash, const juce::String& newHash)
{
    return oldHash.isNotEmpty() && newHash.isNotEmpty()
        && safePath(target, target.isDirectory()) && safePath(candidate, candidate.isDirectory())
        && fingerprint(target) == oldHash && fingerprint(candidate) == newHash
        && exchange(target, candidate);
}

pid_t launchApplication(const juce::File& target, const juce::File& receipt = {})
{
   #if JUCE_MAC
    // LaunchServices preserves the normal Gatekeeper/unsigned-app experience.
    juce::StringArray args { "-n", "-W", target.getFullPathName() };
    if (receipt != juce::File()) args.addArray({ "--args", "--openstudio-update-receipt", receipt.getFullPathName() });
    return launch(juce::File("/usr/bin/open"), args);
   #else
    return launch(target, {}, receipt);
   #endif
}

bool validTransaction(const juce::File& transaction)
{
    const auto name = transaction.getFileName();
    return name.length() == 32 && name.containsOnly("0123456789abcdef") && safePath(transaction, true);
}
}

juce::File installedApplication()
{
   #if JUCE_MAC
    const auto exe = juce::File::getSpecialLocation(juce::File::currentExecutableFile);
    const auto bundle = exe.getParentDirectory().getParentDirectory().getParentDirectory();
    return bundle.hasFileExtension("app") ? bundle : juce::File();
   #else
    const auto path = juce::SystemStats::getEnvironmentVariable("APPIMAGE", {});
    const auto appDir = juce::SystemStats::getEnvironmentVariable("APPDIR", {});
    if (!juce::File::isAbsolutePath(path) || !juce::File::isAbsolutePath(appDir)) return {};
    // Only the AppImage runtime's installed image is eligible; never /usr/bin.
    const auto exe = juce::File::getSpecialLocation(juce::File::currentExecutableFile);
    return exe.isAChildOf(juce::File(appDir)) && path.endsWithIgnoreCase(".AppImage") ? juce::File(path) : juce::File();
   #endif
}

bool registerRunningApplication(const juce::String& startupReceipt)
{
    launchReceipt = startupReceipt;
    const auto target = installedApplication();
    if (target != juce::File() && ::access(target.getParentDirectory().getFullPathName().toRawUTF8(), W_OK) != 0) return true;
    if (target != juce::File() && safePath(target, macOS))
    {
        runningLock = lockFile(target.getParentDirectory(), ".OpenStudio-running.lock", LOCK_SH);
        // A new instance must not run through another process's atomic swap.
        return runningLock >= 0;
    }
    return true; // Non-updatable locations still support normal application use.
}

bool prepare(const juce::File& package, const juce::var& envelope,
             const juce::File& stateRoot, juce::File& transaction, juce::String& error,
             std::function<bool()> shouldCancel)
{
    const auto target = installedApplication();
    if (target == juce::File() || !safePath(target, macOS) || runningLock < 0)
    {
        error = macOS ? "Automatic installation needs an app owned by you in a writable, trusted folder (for example ~/Applications). Install the downloaded DMG manually for this location."
                         : "Automatic installation is available for a user-owned AppImage in a writable, trusted folder. Use your package manager or install the downloaded AppImage manually for this location.";
        return false;
    }
    const auto root = stateRoot.getChildFile("install-transactions");
    if (!root.createDirectory() || !safePath(root, true)) { error = "The updater state folder is not secure or writable."; return false; }
    transaction = root.getChildFile(juce::Uuid().toString());
    if (::mkdir(transaction.getFullPathName().toRawUTF8(), 0700) != 0) { error = "Cannot create an update transaction."; return false; }
    auto request = juce::var(new juce::DynamicObject());
    request.getDynamicObject()->setProperty("target", target.getFullPathName());
    request.getDynamicObject()->setProperty("package", package.getFullPathName());
    request.getDynamicObject()->setProperty("envelope", envelope);
    request.getDynamicObject()->setProperty("parent", static_cast<int>(::getpid()));
    request.getDynamicObject()->setProperty("currentVersion", OPENSTUDIO_INSTALLER_VERSION);
    const auto currentExe = juce::File::getSpecialLocation(juce::File::currentExecutableFile);
    const auto source = macOS ? currentExe.getParentDirectory().getParentDirectory().getChildFile("Helpers/OpenStudioUpdateInstaller")
                                : currentExe.getSiblingFile("OpenStudioUpdateInstaller");
    const auto helper = transaction.getChildFile("helper");
    if (!safePath(package, false) || !source.copyFileTo(helper) || !helper.setExecutePermission(true)
        || !writeMarker(transaction, "request.json", juce::JSON::toString(request, true)))
    { error = "Could not stage the update helper or request."; return false; }
    const auto child = launch(helper, { "--transaction", transaction.getFullPathName() });
    if (child <= 0) { error = "Could not start the update helper."; return false; }
    for (int i = 0; i < preparationSeconds * 10; ++i)
    {
        if (shouldCancel && shouldCancel()) break;
        if (exists(transaction, "ready")) return true;
        if (exists(transaction, "result")) { error = transaction.getChildFile("result").loadFileAsString(); return false; }
        int status = 0;
        if (::waitpid(child, &status, WNOHANG) == child) break;
        juce::Thread::sleep(100);
    }
    cancel(transaction);
    error = "Update preparation did not finish. The installed application has not been replaced.";
    return false;
}

void cancel(const juce::File& transaction)
{
    if (validTransaction(transaction)) writeMarker(transaction, "cancel", "cancel");
}
void commit(const juce::File& transaction)
{
    if (validTransaction(transaction) && exists(transaction, "ready") && !exists(transaction, "cancel"))
        writeMarker(transaction, "commit", "normal shutdown");
}

void acknowledgeFrontendReady()
{
    const auto path = launchReceipt.isNotEmpty() ? launchReceipt : juce::SystemStats::getEnvironmentVariable("OPENSTUDIO_UPDATE_RECEIPT", {});
    if (!juce::File::isAbsolutePath(path)) return;
    const juce::File transaction(path);
    if (!validTransaction(transaction)) return;
    const auto request = juce::JSON::parse(transaction.getChildFile("request.json"));
    if (request["target"].toString() != installedApplication().getFullPathName()) return;
    juce::String error;
    const auto payload = UpdateManifest::verify(request["envelope"], UpdateManifest::publicKey(), error);
    if (payload["version"].toString() == OPENSTUDIO_INSTALLER_VERSION)
        writeMarker(transaction, "healthy", OPENSTUDIO_INSTALLER_VERSION);
}

juce::String previousResult(const juce::File& stateRoot)
{
    const auto root = stateRoot.getChildFile("install-transactions");
    juce::Array<juce::File> dirs;
    root.findChildFiles(dirs, juce::File::findDirectories, false);
    juce::File newest;
    for (const auto& dir : dirs)
        if (validTransaction(dir) && (newest == juce::File() || dir.getCreationTime() > newest.getCreationTime())) newest = dir;
    if (newest == juce::File()) return {};
    const auto result = newest.getChildFile("result").loadFileAsString();
    if (result.isNotEmpty()) return result;
    if (exists(newest, "swapping")) return "An update was started but has not confirmed completion. Recovery files are retained at: " + newest.getChildFile("backup-path").loadFileAsString();
    return {};
}

static int runTransaction(const juce::File& transaction, const juce::String& trustedKey,
                          int shutdownTimeout, int startupTimeout)
{
    if (!validTransaction(transaction)) return 2;
    auto fail = [&](const juce::String& message) { writeMarker(transaction, "result", message); return 2; };
    const auto request = juce::JSON::parse(transaction.getChildFile("request.json"));
    if (!request.isObject() || !juce::File::isAbsolutePath(request["target"].toString())
        || !juce::File::isAbsolutePath(request["package"].toString())) return fail("Invalid update request.");
    const juce::File target(request["target"].toString()), package(request["package"].toString());
    const auto parent = static_cast<pid_t>(static_cast<int>(request["parent"]));
    if (parent <= 1 || ::getppid() != parent) return fail("The update's originating application is no longer running.");
    if (!safePath(target, macOS) || !safePath(package, false)) return fail("Unsafe installation or package path; installation refused.");
    Descriptor transactionLock { lockFile(target.getParentDirectory(), ".OpenStudio-install.lock", LOCK_EX) };
    if (transactionLock.value < 0) return fail("Another update is already in progress, or the installation folder is not writable.");
    juce::String error;
    const auto manifest = UpdateManifest::verify(request["envelope"], trustedKey, error);
    const auto platform = manifest["platforms"][juce::Identifier(platformName)];
    if (!manifest.isObject() || manifest["channel"].toString() != OPENSTUDIO_INSTALLER_CHANNEL
        || !UpdateManifest::numericVersion(manifest["version"].toString())
        || UpdateManifest::compareVersions(manifest["version"].toString(), OPENSTUDIO_INSTALLER_VERSION) <= 0
        || request["currentVersion"].toString() != OPENSTUDIO_INSTALLER_VERSION
        || !UpdateManifest::compatible(platform, UpdateManifest::architecture(), UpdateManifest::systemVersion(), UpdateManifest::libcVersion(), error))
        return fail("The helper rejected the update signature, version, channel or compatibility: " + error);
    const auto size = static_cast<juce::int64>(platform["size"]);
    if (size <= 0 || size > 2LL * 1024 * 1024 * 1024 || package.getSize() != size
        || juce::SHA256(package).toHexString() != platform["sha256"].toString()) return fail("The package changed or failed verification.");
    if (target.getParentDirectory().getBytesFreeOnVolume() < size * 4 + 64 * 1024 * 1024)
        return fail("There is not enough free disk space to prepare an update and retain recovery files.");

    const auto workspace = target.getSiblingFile(".OpenStudio-update-" + transaction.getFileName());
    if (::mkdir(workspace.getFullPathName().toRawUTF8(), 0700) != 0) return fail("Could not reserve a private staging folder beside the application.");
    const auto candidate = workspace.getChildFile(target.getFileName());
    // After a swap this same path contains the complete previous version. Never
    // recursively delete it automatically, including after crashes/power loss.
    if (!writeMarker(transaction, "backup-path", candidate.getFullPathName())) return fail("Could not persist the recovery location.");
    const auto oldHash = fingerprint(target);
    if (oldHash.isEmpty()) return fail("The installed application contains unsupported files or links.");
   #if JUCE_MAC
    const auto image = workspace.getChildFile("update.dmg");
    if (!package.copyFileTo(image) || juce::SHA256(image).toHexString() != platform["sha256"].toString()) return fail("Could not securely copy the update disk image.");
    const auto mount = workspace.getChildFile("mount");
    if (!mount.createDirectory()) return fail("Could not create the disk image mount point.");
    juce::String output;
    if (!command({ "/usr/bin/hdiutil", "attach", "-readonly", "-nobrowse", "-noautoopen", "-mountpoint", mount.getFullPathName(), image.getFullPathName() }, output))
        return fail("Could not mount the verified update disk image: " + output);
    struct Unmount { juce::File path; ~Unmount() { juce::String ignored; command({ "/usr/bin/hdiutil", "detach", path.getFullPathName() }, ignored); } } unmount { mount };
    const auto app = mount.getChildFile("OpenStudio.app");
    if (app.isSymbolicLink() || !app.isDirectory() || fingerprint(app).isEmpty()) return fail("The disk image does not contain a safe OpenStudio app bundle.");
    auto plist = [&](const juce::File& bundle, const char* field) {
        juce::String value;
        return command({ "/usr/libexec/PlistBuddy", "-c", juce::String("Print :") + field,
                         bundle.getChildFile("Contents/Info.plist").getFullPathName() }, value) ? value.trim() : juce::String();
    };
    const auto bundleId = plist(target, "CFBundleIdentifier");
    if (bundleId.isEmpty() || plist(app, "CFBundleIdentifier") != bundleId
        || plist(app, "CFBundleExecutable") != "OpenStudio"
        || plist(app, "CFBundleShortVersionString") != manifest["version"].toString()) return fail("The update bundle identity or version does not match.");
    // Preserve Developer ID continuity if the current build has it. Unsigned
    // distribution still relies on the independently signed manifest. No xattr
    // removal, Gatekeeper bypass, root helper, or system trust changes.
    juce::String identity;
    command({ "/usr/bin/codesign", "-dv", "--verbose=4", target.getFullPathName() }, identity);
    for (const auto& line : juce::StringArray::fromLines(identity))
        if (line.startsWith("TeamIdentifier=") && line.fromFirstOccurrenceOf("=", false, false) != "not set")
        {
            const auto team = line.fromFirstOccurrenceOf("=", false, false).trim();
            if (!team.containsOnly("ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789")
                || !command({ "/usr/bin/codesign", "--verify", "--deep", "--strict", "-R",
                              "anchor apple generic and certificate leaf[subject.OU] = \"" + team + "\"", app.getFullPathName() }, output))
                return fail("The update does not preserve this installation's Apple signing identity.");
        }
    if (!command({ "/usr/bin/ditto", app.getFullPathName(), candidate.getFullPathName() }, output)) return fail("Could not copy the update app: " + output);
    // Gatekeeper assessment is intentionally left to macOS when launching.
   #else
    juce::MemoryBlock header;
    if (auto input = package.createInputStream())
    {
        header.setSize(11, true);
        if (input->read(header.getData(), 11) != 11) header.reset();
    }
    const auto* bytes = static_cast<const unsigned char*>(header.getData());
    if (header.getSize() != 11 || bytes[0] != 0x7f || bytes[1] != 'E' || bytes[2] != 'L' || bytes[3] != 'F'
        || bytes[8] != 'A' || bytes[9] != 'I' || bytes[10] != 2) return fail("The update is not a type-2 AppImage.");
    if (!package.copyFileTo(candidate) || !candidate.setExecutePermission(true)
        || juce::SHA256(candidate).toHexString() != platform["sha256"].toString()) return fail("Could not stage and verify the AppImage.");
   #endif
    const auto newHash = fingerprint(candidate, true);
    if (newHash.isEmpty() || !syncDirectory(workspace)
        || !writeMarker(transaction, "prepared", newHash + "\n" + oldHash)
        || !writeMarker(transaction, "ready", "ready")) return fail("Could not safely persist the prepared update.");
    bool authorised = false;
    for (int i = 0; i < shutdownTimeout * 10; ++i)
    {
        if (exists(transaction, "cancel")) return fail("Update cancelled. The installed application was not changed.");
        if (transaction.getChildFile("commit").loadFileAsString() == "normal shutdown"
            && ::kill(parent, 0) != 0 && errno == ESRCH) { authorised = true; break; }
        juce::Thread::sleep(100);
    }
    if (!authorised) return fail("Update postponed because OpenStudio did not finish an authorised shutdown within two minutes.");
    Descriptor applicationLock { lockFile(target.getParentDirectory(), ".OpenStudio-running.lock", LOCK_EX) };
    if (applicationLock.value < 0) return fail("Another OpenStudio instance is using this installation. Close all instances and retry.");
    if (!safePath(target, macOS) || !safePath(workspace, true)
        || fingerprint(target) != oldHash || fingerprint(candidate) != newHash || exists(transaction, "cancel"))
        return fail("The application or staged update changed after preparation. Installation refused.");
    if (!writeMarker(transaction, "swapping", "swap authorised") || !syncDirectory(transaction)) return fail("Could not persist the installation journal.");
    if (!swapVerified(target, candidate, oldHash, newHash)) return fail("The installation changed or this filesystem cannot safely exchange the application and its backup. Use manual installation.");
    syncDirectory(target.getParentDirectory()); syncDirectory(workspace);
    writeMarker(transaction, "swapped", "awaiting frontend readiness");
    // Release the exclusive application lock before the new process takes its
    // shared lock. Retain the transaction lock through startup/recovery.
    ::close(applicationLock.value); applicationLock.value = -1;
    const auto child = launchApplication(target, transaction);
    bool exited = child <= 0;
    for (int i = 0; !exited && i < startupTimeout * 10; ++i)
    {
        if (transaction.getChildFile("healthy").loadFileAsString() == manifest["version"].toString())
        {
            writeMarker(transaction, "result", "Update installed and the main interface started successfully. Previous version retained at: " + candidate.getFullPathName());
            return 0;
        }
        int status = 0;
        exited = ::waitpid(child, &status, WNOHANG) == child;
        if (!exited) juce::Thread::sleep(100);
    }
    // Never terminate a running app or roll files back underneath it: it may
    // already contain user edits. Preserve both versions when readiness is late.
    if (!exited) return fail("The updated app has not confirmed startup. It was left running; the previous version is retained at: " + candidate.getFullPathName());
    Descriptor recoveryLock { lockFile(target.getParentDirectory(), ".OpenStudio-running.lock", LOCK_EX) };
    if (recoveryLock.value < 0 || !swapVerified(target, candidate, newHash, oldHash))
        return fail("Automatic recovery could not safely replace the failed update. Previous version retained at: " + candidate.getFullPathName());
    syncDirectory(target.getParentDirectory()); syncDirectory(workspace);
    writeMarker(transaction, "result", "The update exited before its interface was ready. The previous version was restored. macOS may require Open Anyway for an unsigned release.");
    ::close(recoveryLock.value); recoveryLock.value = -1;
    launchApplication(target);
    return 2;
}

int runHelper(const juce::File& transaction)
{
    return runTransaction(transaction, UpdateManifest::publicKey(), shutdownSeconds, startupSeconds);
}

#if defined(OPENSTUDIO_INSTALLER_TEST_FIXTURES)
 #include "UpdateInstallerIntegration.h"
#endif

int selfTest(const juce::File& directory)
{
    const auto root = directory.getChildFile(juce::Uuid().toString());
    if (!root.createDirectory()) return 2;
    const auto a = root.getChildFile("old app"), b = root.getChildFile("new app");
    if (!a.replaceWithText("old") || !b.replaceWithText("new")) return 2;
    const auto oldHash = fingerprint(a), newHash = fingerprint(b);
    juce::Array<juce::var> checks;
    bool pass = true;
    auto check = [&](const char* name, bool result) {
        auto value = juce::var(new juce::DynamicObject());
        value.getDynamicObject()->setProperty("name", name);
        value.getDynamicObject()->setProperty("pass", result);
        checks.add(value); pass = pass && result;
    };
    check("atomic_file_replacement_retains_old_bytes", oldHash.isNotEmpty() && oldHash != newHash && swapVerified(a, b, oldHash, newHash)
        && fingerprint(a) == newHash && fingerprint(b) == oldHash);
    check("rollback_restores_exact_original", swapVerified(a, b, newHash, oldHash) && fingerprint(a) == oldHash);
    b.replaceWithText("tampered");
    check("staged_tampering_leaves_installed_app_intact", !swapVerified(a, b, oldHash, newHash) && a.loadFileAsString() == "old");
    b.replaceWithText("new");
    a.replaceWithText("changed installed app");
    check("concurrent_installed_change_prevents_swap", !swapVerified(a, b, oldHash, newHash) && a.loadFileAsString() == "changed installed app");
    a.replaceWithText("old");
    check("missing_hash_cannot_authorise_swap", !swapVerified(a, b, {}, newHash));
    const auto link = root.getChildFile("link");
    check("symlink_target_rejected", ::symlink(a.getFullPathName().toRawUTF8(), link.getFullPathName().toRawUTF8()) == 0
        && !safePath(link, false) && !swapVerified(link, b, oldHash, newHash));
    ::chmod(a.getFullPathName().toRawUTF8(), 0666);
    check("world_writable_target_rejected", !safePath(a, false));
    ::chmod(a.getFullPathName().toRawUTF8(), 0644);
    const auto hard = root.getChildFile("hardlink");
    check("hardlinked_package_rejected", ::link(a.getFullPathName().toRawUTF8(), hard.getFullPathName().toRawUTF8()) == 0 && fingerprint(a).isEmpty());
    hard.deleteFile();
    Descriptor first { lockFile(root, "lock", LOCK_EX) };
    Descriptor second { lockFile(root, "lock", LOCK_EX) };
    check("concurrent_installer_excluded", first.value >= 0 && second.value < 0);
    Descriptor sharedA { lockFile(root, "running", LOCK_SH) }, sharedB { lockFile(root, "running", LOCK_SH) };
    Descriptor exclusive { lockFile(root, "running", LOCK_EX) };
    check("running_instances_prevent_installation", sharedA.value >= 0 && sharedB.value >= 0 && exclusive.value < 0);
    check("journal_markers_cannot_be_overwritten", writeMarker(root, "once", "one") && !writeMarker(root, "once", "two"));
    check("failed_exchange_preserves_target", !exchange(a, root.getChildFile("missing")) && a.loadFileAsString() == "old");
    const auto oldBundle = root.getChildFile("Old.app"), newBundle = root.getChildFile("New.app");
    oldBundle.getChildFile("Contents").createDirectory(); newBundle.getChildFile("Contents").createDirectory();
    oldBundle.getChildFile("Contents/file").replaceWithText("old bundle");
    newBundle.getChildFile("Contents/file").replaceWithText("new bundle");
    const auto oldBundleHash = fingerprint(oldBundle, true), newBundleHash = fingerprint(newBundle, true);
    check("atomic_bundle_swap_and_rollback", swapVerified(oldBundle, newBundle, oldBundleHash, newBundleHash)
        && oldBundle.getChildFile("Contents/file").loadFileAsString() == "new bundle"
        && swapVerified(oldBundle, newBundle, newBundleHash, oldBundleHash)
        && oldBundle.getChildFile("Contents/file").loadFileAsString() == "old bundle");
    const auto escapingLink = oldBundle.getChildFile("escape");
    check("bundle_link_escape_rejected", ::symlink(a.getFullPathName().toRawUTF8(), escapingLink.getFullPathName().toRawUTF8()) == 0
        && fingerprint(oldBundle).isEmpty());
    const auto tx = root.getChildFile(juce::Uuid().toString()); tx.createDirectory();
    cancel(tx); commit(tx);
    check("cancelled_transaction_cannot_commit", exists(tx, "cancel") && !exists(tx, "commit"));
    const auto unprepared = root.getChildFile(juce::Uuid().toString()); unprepared.createDirectory(); commit(unprepared);
    check("unprepared_transaction_cannot_commit", !exists(unprepared, "commit"));
    const auto prepared = root.getChildFile(juce::Uuid().toString()); prepared.createDirectory();
    writeMarker(prepared, "ready", "ready"); commit(prepared);
    check("prepared_transaction_requires_explicit_commit", prepared.getChildFile("commit").loadFileAsString() == "normal shutdown");
#if defined(OPENSTUDIO_INSTALLER_TEST_FIXTURES)
    runIntegrationFixtures(root, check);
#endif
    auto report = juce::var(new juce::DynamicObject());
    report.getDynamicObject()->setProperty("pass", pass); report.getDynamicObject()->setProperty("checks", checks);
    directory.getChildFile("installer-result.json").replaceWithText(juce::JSON::toString(report, true));
    return pass ? 0 : 2;
}
#else
juce::File installedApplication() { return {}; }
bool prepare(const juce::File&, const juce::var&, const juce::File&, juce::File&, juce::String&, std::function<bool()>) { return false; }
void cancel(const juce::File&) {}
void commit(const juce::File&) {}
bool registerRunningApplication(const juce::String&) { return true; }
void acknowledgeFrontendReady() {}
juce::String previousResult(const juce::File&) { return {}; }
int runHelper(const juce::File&) { return 2; }
int selfTest(const juce::File&) { return 2; }
#endif
}
