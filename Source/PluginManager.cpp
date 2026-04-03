#include "PluginManager.h"
#include "S13FXProcessor.h"
#include "CLAPPluginFormat.h"

namespace
{
juce::File getOpenStudioDocumentsDirectory()
{
    auto documentsDir = juce::File::getSpecialLocation(juce::File::userDocumentsDirectory);
    return documentsDir.getChildFile("OpenStudio");
}

juce::File getLegacyStudio13DocumentsDirectory()
{
    auto documentsDir = juce::File::getSpecialLocation(juce::File::userDocumentsDirectory);
    return documentsDir.getChildFile("Studio13");
}
}

PluginManager::PluginManager()
{
    // Add default formats (VST3, LV2, AU, etc.)
    formatManager.addDefaultFormats();

    // Add CLAP hosting (not built into JUCE — custom format)
    formatManager.addFormat(new CLAPPluginFormat());

    // Debug: Log how many formats were added
    juce::Logger::writeToLog("PluginManager: Constructor - formatManager has " +
                           juce::String(formatManager.getNumFormats()) + " formats");

    for (int i = 0; i < formatManager.getNumFormats(); ++i)
    {
        auto* format = formatManager.getFormat(i);
        juce::Logger::writeToLog("PluginManager: Format " + juce::String(i) + ": " + format->getName());
    }

    pluginListFile = getOpenStudioDocumentsDirectory().getChildFile("PluginList.xml");
    auto legacyPluginListFile = getLegacyStudio13DocumentsDirectory().getChildFile("PluginList.xml");
    if (!pluginListFile.existsAsFile() && legacyPluginListFile.existsAsFile())
        pluginListFile = legacyPluginListFile;

    blacklistFile = getOpenStudioDocumentsDirectory().getChildFile("PluginBlacklist.txt");
    auto legacyBlacklistFile = getLegacyStudio13DocumentsDirectory().getChildFile("PluginBlacklist.txt");
    if (!blacklistFile.existsAsFile() && legacyBlacklistFile.existsAsFile())
        blacklistFile = legacyBlacklistFile;

    if (blacklistFile.existsAsFile())
        blacklistFile.readLines(blacklistedPlugins);

    // Load existing plugin list if available
    loadPluginList();

    // Ensure user effects directory exists
    getUserEffectsDirectory().createDirectory();
}

PluginManager::~PluginManager()
{
    savePluginList();
}

void PluginManager::scanForPlugins()
{
    // Create debug log file
    juce::File debugLog = getOpenStudioDocumentsDirectory().getChildFile("plugin_scan_debug.txt");
    debugLog.getParentDirectory().createDirectory();
    debugLog.deleteFile();
    debugLog.create();
    
    auto writeLog = [&debugLog](const juce::String& message) {
        juce::Logger::writeToLog(message);
        debugLog.appendText(message + "\n");
    };
    
    writeLog("PluginManager: Starting plugin scan...");
    writeLog("PluginManager: Number of formats available: " + juce::String(formatManager.getNumFormats()));
    
    // Clear existing list
    knownPluginList.clear();
    
    // Scan for each plugin format
    for (int i = 0; i < formatManager.getNumFormats(); ++i)
    {
        auto* format = formatManager.getFormat(i);
        writeLog("PluginManager: Scanning " + format->getName() + " plugins...");
        
        // Get default plugin search paths for this format
        juce::FileSearchPath searchPaths = format->getDefaultLocationsToSearch();
        
        // Add additional common plugin locations manually
        if (format->getName().contains("VST3"))
        {
            // Common VST3 locations on Windows
            searchPaths.add(juce::File("C:\\Program Files\\Common Files\\VST3"));
            searchPaths.add(juce::File("C:\\Program Files\\Steinberg\\VstPlugins"));
            searchPaths.add(juce::File("C:\\Program Files\\VSTPlugins"));
            searchPaths.add(juce::File::getSpecialLocation(juce::File::userApplicationDataDirectory)
                           .getChildFile("VST3"));
        }
        else if (format->getName().contains("LV2"))
        {
            // Common LV2 locations on Windows
            searchPaths.add(juce::File("C:\\Program Files\\Common Files\\LV2"));
            searchPaths.add(juce::File("C:\\Program Files\\LV2"));
            searchPaths.add(juce::File::getSpecialLocation(juce::File::userApplicationDataDirectory)
                           .getChildFile("LV2"));
            // User home .lv2
            searchPaths.add(juce::File::getSpecialLocation(juce::File::userHomeDirectory)
                           .getChildFile(".lv2"));
        }
        else if (format->getName() == "CLAP")
        {
            // Common CLAP locations on Windows
            searchPaths.add(juce::File("C:\\Program Files\\Common Files\\CLAP"));
        }
        
        writeLog("PluginManager: Search paths: " + searchPaths.toString());
        writeLog("PluginManager: Number of search paths: " + juce::String(searchPaths.getNumPaths()));
        
        // Log each individual path
        for (int p = 0; p < searchPaths.getNumPaths(); ++p)
        {
            auto path = searchPaths[p];
            writeLog("PluginManager: Path " + juce::String(p) + ": " + path.getFullPathName());
            writeLog("PluginManager: Path exists: " + juce::String(path.exists() ? "YES" : "NO"));
            if (path.exists())
            {
                writeLog("PluginManager: Path is directory: " + juce::String(path.isDirectory() ? "YES" : "NO"));
                
                // List files in this directory
                juce::Array<juce::File> files;
                path.findChildFiles(files, juce::File::findFilesAndDirectories, true, "*.vst3;*.lv2");
                writeLog("PluginManager: Found " + juce::String(files.size()) + " plugin files in this path");
            }
        }
        
        // Get all plugin files in these locations
        auto fileOrIdentifiers = format->searchPathsForPlugins(searchPaths, true, false);
        
        writeLog("PluginManager: Found " + juce::String(fileOrIdentifiers.size()) + " potential plugin files");
        
        // Scan each plugin
        int foundCount = 0;
        for (const auto& fileOrIdentifier : fileOrIdentifiers)
        {
            writeLog("PluginManager: Checking: " + fileOrIdentifier);
            
            if (format->fileMightContainThisPluginType(fileOrIdentifier))
            {
                juce::OwnedArray<juce::PluginDescription> foundDescriptions;
                format->findAllTypesForFile(foundDescriptions, fileOrIdentifier);
                
                for (auto* desc : foundDescriptions)
                {
                    knownPluginList.addType(*desc);
                    foundCount++;
                    writeLog("PluginManager: ✓ Found plugin: " + desc->name + " by " + desc->manufacturerName);
                }
            }
            else
            {
                writeLog("PluginManager: ✗ File does not contain this plugin type");
            }
        }
        
        writeLog("PluginManager: Format " + format->getName() + " scan complete. Found " + juce::String(foundCount) + " plugins");
    }
    
    writeLog("PluginManager: ========================================");
    writeLog("PluginManager: SCAN COMPLETE. Total plugins found: " +
                           juce::String(knownPluginList.getNumTypes()));
    writeLog("PluginManager: ========================================");
    writeLog("PluginManager: Debug log saved to: " + debugLog.getFullPathName());
    savePluginList();

    // Also scan for S13FX/JSFX scripts
    scanForS13FX();
}

juce::Array<juce::PluginDescription> PluginManager::getAvailablePlugins() const
{
    juce::Array<juce::PluginDescription> plugins;
    
    for (const auto& type : knownPluginList.getTypes())
    {
        plugins.add(type);
    }
    
    return plugins;
}

std::unique_ptr<juce::AudioProcessor> PluginManager::loadPlugin(const juce::PluginDescription& description,
                                                               double sampleRate, int blockSize)
{
    // Refuse to load blacklisted plugins (previously crashed)
    if (isPluginBlacklisted(description.fileOrIdentifier))
    {
        juce::Logger::writeToLog("PluginManager: Refusing to load blacklisted plugin: " + description.name);
        return nullptr;
    }

    juce::String errorMessage;

    // Clamp block size to at least 512 — ASIO buffers can be as small as 32 samples,
    // but createPluginInstance uses this to initialise the plugin's internal DSP sizing.
    int safeBlockSize = juce::jmax(blockSize, 512);
    auto plugin = formatManager.createPluginInstance(description, sampleRate, safeBlockSize, errorMessage);

    if (plugin == nullptr)
    {
        juce::Logger::writeToLog("PluginManager: Failed to load plugin: " + errorMessage);
    }
    else
    {
        // Don't force a bus layout here — let the plugin use its default
        // (e.g. mono-in/stereo-out for guitar amp sims like Amplitube).
        // The TrackProcessor::safeProcessFX wrapper handles any channel mismatch.
        juce::Logger::writeToLog("PluginManager: Successfully loaded: " + description.name +
                                 " (inCh=" + juce::String(plugin->getTotalNumInputChannels()) +
                                 " outCh=" + juce::String(plugin->getTotalNumOutputChannels()) + ")");
    }

    return plugin;
}

std::unique_ptr<juce::AudioProcessor> PluginManager::loadPluginFromFile(const juce::String& filePath,
                                                                       double sampleRate, int blockSize)
{
    juce::Logger::writeToLog("PluginManager: Loading plugin from: " + filePath);

    // 1. Exact match in known list
    for (const auto& desc : knownPluginList.getTypes())
    {
        if (desc.fileOrIdentifier == filePath)
        {
            juce::Logger::writeToLog("PluginManager: Exact match found in known list");
            return loadPlugin(desc, sampleRate, blockSize);
        }
    }

    // 2. Partial match — the saved fileOrIdentifier from a loaded plugin instance
    //    may be the inner module path (e.g. .../Contents/x86_64-win/Plugin.vst3)
    //    while the known list stores the bundle path (e.g. .../Plugin.vst3).
    //    Try matching if one path contains the other.
    for (const auto& desc : knownPluginList.getTypes())
    {
        if (filePath.contains(desc.fileOrIdentifier) || desc.fileOrIdentifier.contains(filePath))
        {
            juce::Logger::writeToLog("PluginManager: Partial match found: " + desc.fileOrIdentifier);
            return loadPlugin(desc, sampleRate, blockSize);
        }
    }

    // 3. Direct scan — try to load from the file path directly
    juce::File pluginFile(filePath);
    // Walk up to find the plugin bundle directory if we have an inner path
    juce::File bundleFile = pluginFile;
    while (bundleFile.getParentDirectory() != bundleFile &&
           bundleFile.getFileExtension() != ".vst3" &&
           bundleFile.getFileExtension() != ".lv2" &&
           bundleFile.getFileExtension() != ".clap")
    {
        bundleFile = bundleFile.getParentDirectory();
    }

    for (int i = 0; i < formatManager.getNumFormats(); ++i)
    {
        auto* format = formatManager.getFormat(i);
        juce::String candidate = bundleFile.getFullPathName();
        if (format->fileMightContainThisPluginType(candidate))
        {
            juce::OwnedArray<juce::PluginDescription> descriptions;
            format->findAllTypesForFile(descriptions, candidate);
            if (descriptions.size() > 0)
            {
                juce::Logger::writeToLog("PluginManager: Direct scan found: " + descriptions[0]->name);
                knownPluginList.addType(*descriptions[0]);
                return loadPlugin(*descriptions[0], sampleRate, blockSize);
            }
        }
    }

    juce::Logger::writeToLog("PluginManager: Plugin not found: " + filePath);
    return nullptr;
}

void PluginManager::savePluginList()
{
    if (auto xml = knownPluginList.createXml())
    {
        // Create parent directory if needed
        pluginListFile.getParentDirectory().createDirectory();
        
        if (xml->writeTo(pluginListFile))
        {
            juce::Logger::writeToLog("PluginManager: Saved plugin list to " + pluginListFile.getFullPathName());
        }
    }
}

void PluginManager::loadPluginList()
{
    if (pluginListFile.existsAsFile())
    {
        if (auto xml = juce::parseXML(pluginListFile))
        {
            knownPluginList.recreateFromXml(*xml);
            juce::Logger::writeToLog("PluginManager: Loaded " + juce::String(knownPluginList.getNumTypes()) +
                                   " plugins from " + pluginListFile.getFullPathName());
        }
    }
    else
    {
        juce::Logger::writeToLog("PluginManager: No existing plugin list found");
    }
}

// ---- S13FX / JSFX scanning ----

juce::File PluginManager::getUserEffectsDirectory()
{
    auto openStudioDir = getOpenStudioDocumentsDirectory().getChildFile("Effects");
    auto legacyDir = getLegacyStudio13DocumentsDirectory().getChildFile("Effects");

    if (!openStudioDir.isDirectory() && legacyDir.isDirectory())
        return legacyDir;

    return openStudioDir;
}

juce::File PluginManager::getStockEffectsDirectory()
{
    auto exeDir = juce::File::getSpecialLocation(juce::File::currentExecutableFile)
        .getParentDirectory();

   #if JUCE_MAC
    auto bundleResources = exeDir.getParentDirectory().getChildFile("Resources").getChildFile("effects");
    if (bundleResources.isDirectory())
        return bundleResources;
   #endif

    return exeDir.getChildFile("effects");
}

void PluginManager::scanForS13FX()
{
    s13fxList.clear();

    // Scan stock effects (bundled with app)
    auto stockDir = getStockEffectsDirectory();
    if (stockDir.isDirectory())
        scanDirectory(stockDir, true);

    // Scan user effects
    auto userDir = getUserEffectsDirectory();
    if (userDir.isDirectory())
        scanDirectory(userDir, false);

    juce::Logger::writeToLog("PluginManager: Found " + juce::String(s13fxList.size()) + " S13FX/JSFX scripts");
}

void PluginManager::scanDirectory(const juce::File& dir, bool isStock)
{
    juce::Array<juce::File> files;
    dir.findChildFiles(files, juce::File::findFiles, true, "*.jsfx;*.s13fx");

    for (const auto& file : files)
    {
        S13FXInfo info;
        info.filePath = file.getFullPathName();
        info.isStock = isStock;

        // Try to extract metadata by loading the script header (first 50 lines)
        juce::StringArray lines;
        file.readLines(lines);

        info.name = file.getFileNameWithoutExtension();

        for (int i = 0; i < juce::jmin(lines.size(), 50); ++i)
        {
            auto line = lines[i].trim();

            if (line.startsWith("desc:"))
                info.name = line.fromFirstOccurrenceOf("desc:", false, false).trim();
            else if (line.startsWith("author:"))
                info.author = line.fromFirstOccurrenceOf("author:", false, false).trim();
            else if (line.startsWith("tags:"))
            {
                auto tagStr = line.fromFirstOccurrenceOf("tags:", false, false).trim();
                info.tags.addTokens(tagStr, " ", "");
            }
        }

        s13fxList.push_back(std::move(info));
        juce::Logger::writeToLog("PluginManager: Found S13FX: " + info.name +
                                 (isStock ? " (stock)" : " (user)"));
    }
}

// ---- Plugin crash isolation (blacklist) ----

bool PluginManager::isPluginBlacklisted(const juce::String& pluginId) const
{
    return blacklistedPlugins.contains(pluginId);
}

void PluginManager::blacklistPlugin(const juce::String& pluginId)
{
    if (!blacklistedPlugins.contains(pluginId))
    {
        blacklistedPlugins.add(pluginId);
        blacklistFile.getParentDirectory().createDirectory();
        blacklistFile.replaceWithText(blacklistedPlugins.joinIntoString("\n"));
        juce::Logger::writeToLog("PluginManager: Blacklisted plugin: " + pluginId);
    }
}

void PluginManager::removeFromBlacklist(const juce::String& pluginId)
{
    int idx = blacklistedPlugins.indexOf(pluginId);
    if (idx >= 0)
    {
        blacklistedPlugins.remove(idx);
        blacklistFile.replaceWithText(blacklistedPlugins.joinIntoString("\n"));
        juce::Logger::writeToLog("PluginManager: Removed from blacklist: " + pluginId);
    }
}

juce::StringArray PluginManager::getBlacklistedPlugins() const
{
    return blacklistedPlugins;
}

bool PluginManager::isARAPlugin(const juce::PluginDescription& description) const
{
    // ARA plugins are VST3 or AU plugins that expose an ARA factory.
    // We detect this by loading the plugin and checking for ARA support.
    // For efficiency, we check the description's hasARAExtension flag
    // (available since JUCE 7 for scanned plugins).
    return description.hasARAExtension;
}

juce::Array<juce::PluginDescription> PluginManager::getARAPlugins() const
{
    juce::Array<juce::PluginDescription> araPlugins;
    for (const auto& desc : knownPluginList.getTypes())
    {
        if (desc.hasARAExtension)
            araPlugins.add(desc);
    }
    return araPlugins;
}
