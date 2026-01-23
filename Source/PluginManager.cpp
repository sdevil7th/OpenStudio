#include "PluginManager.h"

PluginManager::PluginManager()
{
    // Add default formats (VST3, AU, etc.)
    formatManager.addDefaultFormats();
    
    // Debug: Log how many formats were added
    juce::Logger::writeToLog("PluginManager: Constructor - formatManager has " + 
                           juce::String(formatManager.getNumFormats()) + " formats");
    
    for (int i = 0; i < formatManager.getNumFormats(); ++i)
    {
        auto* format = formatManager.getFormat(i);
        juce::Logger::writeToLog("PluginManager: Format " + juce::String(i) + ": " + format->getName());
    }
    
    // Get plugin list file location (Documents/Studio13/PluginList.xml)
    pluginListFile = juce::File::getSpecialLocation(juce::File::userDocumentsDirectory)
        .getChildFile("Studio13").getChildFile("PluginList.xml");
    
    // Load existing plugin list if available
    loadPluginList();
}

PluginManager::~PluginManager()
{
    savePluginList();
}

void PluginManager::scanForPlugins()
{
    // Create debug log file
    juce::File debugLog = juce::File::getSpecialLocation(juce::File::userDocumentsDirectory)
        .getChildFile("Studio13").getChildFile("plugin_scan_debug.txt");
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
        
        // Add additional common VST3 locations manually
        if (format->getName().contains("VST3"))
        {
            // Common VST3 locations on Windows
            searchPaths.add(juce::File("C:\\Program Files\\Common Files\\VST3"));
            searchPaths.add(juce::File("C:\\Program Files\\Steinberg\\VstPlugins"));
            searchPaths.add(juce::File("C:\\Program Files\\VSTPlugins"));
            searchPaths.add(juce::File::getSpecialLocation(juce::File::userApplicationDataDirectory)
                           .getChildFile("VST3"));
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
                path.findChildFiles(files, juce::File::findFiles, true, "*.vst3");
                writeLog("PluginManager: Found " + juce::String(files.size()) + " .vst3 files in this path");
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

std::unique_ptr<juce::AudioProcessor> PluginManager::loadPlugin(const juce::PluginDescription& description)
{
    juce::String errorMessage;
    
    auto plugin = formatManager.createPluginInstance(description, 44100.0, 512, errorMessage);
    
    if (plugin == nullptr)
    {
        juce::Logger::writeToLog("PluginManager: Failed to load plugin: " + errorMessage);
    }
    else
    {
        juce::Logger::writeToLog("PluginManager: Successfully loaded: " + description.name);
    }
    
    return plugin;
}

std::unique_ptr<juce::AudioProcessor> PluginManager::loadPluginFromFile(const juce::String& filePath)
{
    juce::Logger::writeToLog("PluginManager: Loading plugin from: " + filePath);
    
    // Find the plugin description
    for (const auto& desc : knownPluginList.getTypes())
    {
        if (desc.fileOrIdentifier == filePath)
        {
            return loadPlugin(desc);
        }
    }
    
    juce::Logger::writeToLog("PluginManager: Plugin not found in known list");
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
