#pragma once

#include <JuceHeader.h>
#include <functional>
#include <string>
#include <vector>

// Forward declarations — avoid pulling heavy headers into every TU
struct lua_State;
class AudioEngine;

// Lua 5.4 scripting engine for DAW automation (runs on message thread ONLY)
class ScriptEngine
{
public:
    ScriptEngine();
    ~ScriptEngine();

    // Register the full s13.* API surface against the given AudioEngine
    void registerAPI(AudioEngine& engine);

    // Load and execute a .lua file.  Returns true on success.
    bool loadAndRun(const juce::String& scriptPath);

    // Execute an arbitrary Lua string (REPL / console).  Returns true on success.
    bool executeString(const juce::String& luaCode);

    // Last error message from Lua (empty on success)
    juce::String getLastError() const { return lastError; }

    // Accumulated print() output from the last execution
    juce::String getLastOutput() const { return lastOutput; }

    // Get the user scripts directory (Documents/Studio13/Scripts/)
    static juce::File getUserScriptsDirectory();

    // Get the stock scripts directory (<exe>/scripts/)
    static juce::File getStockScriptsDirectory();

    // Enumerate available scripts from both stock and user directories
    struct ScriptInfo
    {
        juce::String name;
        juce::String filePath;
        juce::String description;  // First comment line starting with "-- @desc"
        bool isStock = false;
    };
    std::vector<ScriptInfo> listAvailableScripts() const;

    // Callback invoked by s13.print() — caller can route to frontend console
    std::function<void(const juce::String&)> onPrint;

private:
    lua_State* L = nullptr;
    juce::String lastError;
    juce::String lastOutput;

    // Reset output buffer before each execution
    void resetOutput();

    // Helper: push a C closure that captures AudioEngine*
    void registerFunction(const char* tableName, const char* funcName,
                          int (*func)(lua_State*));

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(ScriptEngine)
};
