#include "ScriptEngine.h"
#include "AudioEngine.h"

// Lua is compiled as C, so we need extern "C" linkage
extern "C" {
#include <lua.h>
#include <lauxlib.h>
#include <lualib.h>
}

// ============================================================================
// Registry key for the AudioEngine pointer stored in Lua
// ============================================================================
static const char* const kEngineKey = "s13_engine_ptr";
static const char* const kScriptEngineKey = "s13_script_engine_ptr";

static AudioEngine* getEngine(lua_State* L)
{
    lua_getfield(L, LUA_REGISTRYINDEX, kEngineKey);
    auto* engine = static_cast<AudioEngine*>(lua_touserdata(L, -1));
    lua_pop(L, 1);
    return engine;
}

static ScriptEngine* getScriptEngine(lua_State* L)
{
    lua_getfield(L, LUA_REGISTRYINDEX, kScriptEngineKey);
    auto* se = static_cast<ScriptEngine*>(lua_touserdata(L, -1));
    lua_pop(L, 1);
    return se;
}

// ============================================================================
// Helper: push a juce::var as a Lua value
// ============================================================================
static void pushVar(lua_State* L, const juce::var& v)
{
    if (v.isVoid() || v.isUndefined())
        lua_pushnil(L);
    else if (v.isBool())
        lua_pushboolean(L, (bool)v ? 1 : 0);
    else if (v.isInt() || v.isInt64())
        lua_pushinteger(L, (lua_Integer)(int64_t)v);
    else if (v.isDouble())
        lua_pushnumber(L, (double)v);
    else if (v.isString())
        lua_pushstring(L, v.toString().toRawUTF8());
    else if (v.isArray())
    {
        auto* arr = v.getArray();
        lua_createtable(L, arr->size(), 0);
        for (int i = 0; i < arr->size(); ++i)
        {
            pushVar(L, (*arr)[i]);
            lua_rawseti(L, -2, i + 1);  // Lua arrays are 1-based
        }
    }
    else if (v.isObject())
    {
        auto* obj = v.getDynamicObject();
        if (obj != nullptr)
        {
            auto& props = obj->getProperties();
            lua_createtable(L, 0, props.size());
            for (int i = 0; i < props.size(); ++i)
            {
                lua_pushstring(L, props.getName(i).toString().toRawUTF8());
                pushVar(L, props.getValueAt(i));
                lua_rawset(L, -3);
            }
        }
        else
        {
            lua_pushnil(L);
        }
    }
    else
    {
        lua_pushstring(L, v.toString().toRawUTF8());
    }
}

// ============================================================================
// s13.print(...)  — capture output for the console
// ============================================================================
static int l_print(lua_State* L)
{
    auto* se = getScriptEngine(L);
    int nargs = lua_gettop(L);
    juce::String line;

    for (int i = 1; i <= nargs; ++i)
    {
        if (i > 1) line += "\t";
        if (lua_isstring(L, i))
            line += lua_tostring(L, i);
        else if (lua_isboolean(L, i))
            line += lua_toboolean(L, i) ? "true" : "false";
        else if (lua_isnil(L, i))
            line += "nil";
        else
            line += luaL_tolstring(L, i, nullptr);
    }

    if (se != nullptr && se->onPrint)
        se->onPrint(line);

    // Also log to JUCE logger for debugging
    juce::Logger::writeToLog("[Lua] " + line);
    return 0;
}

// ============================================================================
// Track operations
// ============================================================================
static int l_getTrackCount(lua_State* L)
{
    auto* engine = getEngine(L);
    if (!engine) { lua_pushinteger(L, 0); return 1; }

    // Use getMeteringData to count tracks (it returns an array with one entry per track)
    auto data = engine->getMeteringData();
    if (auto* arr = data.getArray())
        lua_pushinteger(L, arr->size());
    else
        lua_pushinteger(L, 0);
    return 1;
}

static int l_addTrack(lua_State* L)
{
    auto* engine = getEngine(L);
    if (!engine) { lua_pushnil(L); return 1; }

    juce::String trackId = engine->addTrack();
    lua_pushstring(L, trackId.toRawUTF8());
    return 1;
}

static int l_removeTrack(lua_State* L)
{
    auto* engine = getEngine(L);
    if (!engine) { lua_pushboolean(L, 0); return 1; }

    const char* trackId = luaL_checkstring(L, 1);
    lua_pushboolean(L, engine->removeTrack(juce::String(trackId)) ? 1 : 0);
    return 1;
}

static int l_setTrackVolume(lua_State* L)
{
    auto* engine = getEngine(L);
    if (!engine) return 0;

    const char* trackId = luaL_checkstring(L, 1);
    double volumeDB = luaL_checknumber(L, 2);
    engine->setTrackVolume(juce::String(trackId), (float)volumeDB);
    return 0;
}

static int l_setTrackPan(lua_State* L)
{
    auto* engine = getEngine(L);
    if (!engine) return 0;

    const char* trackId = luaL_checkstring(L, 1);
    double pan = luaL_checknumber(L, 2);
    engine->setTrackPan(juce::String(trackId), (float)pan);
    return 0;
}

static int l_setTrackMute(lua_State* L)
{
    auto* engine = getEngine(L);
    if (!engine) return 0;

    const char* trackId = luaL_checkstring(L, 1);
    bool muted = lua_toboolean(L, 2) != 0;
    engine->setTrackMute(juce::String(trackId), muted);
    return 0;
}

static int l_setTrackSolo(lua_State* L)
{
    auto* engine = getEngine(L);
    if (!engine) return 0;

    const char* trackId = luaL_checkstring(L, 1);
    bool soloed = lua_toboolean(L, 2) != 0;
    engine->setTrackSolo(juce::String(trackId), soloed);
    return 0;
}

static int l_setTrackArm(lua_State* L)
{
    auto* engine = getEngine(L);
    if (!engine) return 0;

    const char* trackId = luaL_checkstring(L, 1);
    bool armed = lua_toboolean(L, 2) != 0;
    engine->setTrackRecordArm(juce::String(trackId), armed);
    return 0;
}

static int l_reorderTrack(lua_State* L)
{
    auto* engine = getEngine(L);
    if (!engine) { lua_pushboolean(L, 0); return 1; }

    const char* trackId = luaL_checkstring(L, 1);
    int newIndex = (int)luaL_checkinteger(L, 2);
    lua_pushboolean(L, engine->reorderTrack(juce::String(trackId), newIndex) ? 1 : 0);
    return 1;
}

// ============================================================================
// Transport
// ============================================================================
static int l_play(lua_State* L)
{
    auto* engine = getEngine(L);
    if (engine) engine->setTransportPlaying(true);
    return 0;
}

static int l_stop(lua_State* L)
{
    auto* engine = getEngine(L);
    if (engine)
    {
        engine->setTransportPlaying(false);
        engine->setTransportRecording(false);
    }
    return 0;
}

static int l_record(lua_State* L)
{
    auto* engine = getEngine(L);
    if (engine)
    {
        engine->setTransportRecording(true);
        engine->setTransportPlaying(true);
    }
    return 0;
}

static int l_isPlaying(lua_State* L)
{
    auto* engine = getEngine(L);
    lua_pushboolean(L, engine && engine->isTransportPlaying() ? 1 : 0);
    return 1;
}

static int l_isRecording(lua_State* L)
{
    auto* engine = getEngine(L);
    lua_pushboolean(L, engine && engine->isTransportRecording() ? 1 : 0);
    return 1;
}

static int l_getPlayhead(lua_State* L)
{
    auto* engine = getEngine(L);
    lua_pushnumber(L, engine ? engine->getTransportPosition() : 0.0);
    return 1;
}

static int l_setPlayhead(lua_State* L)
{
    auto* engine = getEngine(L);
    if (engine)
    {
        double seconds = luaL_checknumber(L, 1);
        engine->setTransportPosition(seconds);
    }
    return 0;
}

static int l_getTempo(lua_State* L)
{
    auto* engine = getEngine(L);
    lua_pushnumber(L, engine ? engine->getTempo() : 120.0);
    return 1;
}

static int l_setTempo(lua_State* L)
{
    auto* engine = getEngine(L);
    if (engine)
    {
        double bpm = luaL_checknumber(L, 1);
        engine->setTempo(bpm);
    }
    return 0;
}

static int l_getTimeSignature(lua_State* L)
{
    auto* engine = getEngine(L);
    int num = 4, den = 4;
    if (engine)
        engine->getTimeSignature(num, den);

    lua_createtable(L, 0, 2);
    lua_pushinteger(L, num);
    lua_setfield(L, -2, "num");
    lua_pushinteger(L, den);
    lua_setfield(L, -2, "den");
    return 1;
}

static int l_setTimeSignature(lua_State* L)
{
    auto* engine = getEngine(L);
    if (engine)
    {
        int num = (int)luaL_checkinteger(L, 1);
        int den = (int)luaL_checkinteger(L, 2);
        engine->setTimeSignature(num, den);
    }
    return 0;
}

static int l_setLoop(lua_State* L)
{
    auto* engine = getEngine(L);
    if (engine)
    {
        bool enabled = lua_toboolean(L, 1) != 0;
        engine->setLoopMode(enabled);
    }
    return 0;
}

// ============================================================================
// FX operations
// ============================================================================
static int l_getTrackFX(lua_State* L)
{
    auto* engine = getEngine(L);
    if (!engine) { lua_pushnil(L); return 1; }

    const char* trackId = luaL_checkstring(L, 1);
    auto fxData = engine->getTrackFX(juce::String(trackId));
    pushVar(L, fxData);
    return 1;
}

static int l_getTrackInputFX(lua_State* L)
{
    auto* engine = getEngine(L);
    if (!engine) { lua_pushnil(L); return 1; }

    const char* trackId = luaL_checkstring(L, 1);
    auto fxData = engine->getTrackInputFX(juce::String(trackId));
    pushVar(L, fxData);
    return 1;
}

static int l_addTrackFX(lua_State* L)
{
    auto* engine = getEngine(L);
    if (!engine) { lua_pushboolean(L, 0); return 1; }

    const char* trackId = luaL_checkstring(L, 1);
    const char* pluginPath = luaL_checkstring(L, 2);
    bool result = engine->addTrackFX(juce::String(trackId), juce::String(pluginPath), false);
    lua_pushboolean(L, result ? 1 : 0);
    return 1;
}

static int l_removeTrackFX(lua_State* L)
{
    auto* engine = getEngine(L);
    if (!engine) return 0;

    const char* trackId = luaL_checkstring(L, 1);
    int fxIndex = (int)luaL_checkinteger(L, 2);
    engine->removeTrackFX(juce::String(trackId), fxIndex);
    return 0;
}

static int l_bypassTrackFX(lua_State* L)
{
    auto* engine = getEngine(L);
    if (!engine) return 0;

    const char* trackId = luaL_checkstring(L, 1);
    int fxIndex = (int)luaL_checkinteger(L, 2);
    bool bypassed = lua_toboolean(L, 3) != 0;
    engine->bypassTrackFX(juce::String(trackId), fxIndex, bypassed);
    return 0;
}

// ============================================================================
// Master
// ============================================================================
static int l_setMasterVolume(lua_State* L)
{
    auto* engine = getEngine(L);
    if (engine)
    {
        float vol = (float)luaL_checknumber(L, 1);
        engine->setMasterVolume(vol);
    }
    return 0;
}

static int l_getMasterVolume(lua_State* L)
{
    auto* engine = getEngine(L);
    lua_pushnumber(L, engine ? engine->getMasterVolume() : 1.0);
    return 1;
}

static int l_setMasterPan(lua_State* L)
{
    auto* engine = getEngine(L);
    if (engine)
    {
        float pan = (float)luaL_checknumber(L, 1);
        engine->setMasterPan(pan);
    }
    return 0;
}

static int l_getMasterPan(lua_State* L)
{
    auto* engine = getEngine(L);
    lua_pushnumber(L, engine ? engine->getMasterPan() : 0.0);
    return 1;
}

// ============================================================================
// MIDI devices
// ============================================================================
static int l_getMIDIDevices(lua_State* L)
{
    auto* engine = getEngine(L);
    if (!engine) { lua_pushnil(L); return 1; }

    auto devices = engine->getMIDIInputDevices();
    pushVar(L, devices);
    return 1;
}

// ============================================================================
// Metronome
// ============================================================================
static int l_setMetronomeEnabled(lua_State* L)
{
    auto* engine = getEngine(L);
    if (engine)
    {
        bool enabled = lua_toboolean(L, 1) != 0;
        engine->setMetronomeEnabled(enabled);
    }
    return 0;
}

static int l_isMetronomeEnabled(lua_State* L)
{
    auto* engine = getEngine(L);
    lua_pushboolean(L, engine && engine->isMetronomeEnabled() ? 1 : 0);
    return 1;
}

// ============================================================================
// Utility
// ============================================================================
static int l_getAppVersion(lua_State* L)
{
    lua_pushstring(L, "0.0.1");
    return 1;
}

static int l_showMessage(lua_State* L)
{
    const char* title = luaL_checkstring(L, 1);
    const char* msg = luaL_checkstring(L, 2);
    juce::AlertWindow::showMessageBoxAsync(juce::MessageBoxIconType::InfoIcon,
                                           juce::String(title), juce::String(msg));
    return 0;
}

// ============================================================================
// Playback clips
// ============================================================================
static int l_addPlaybackClip(lua_State* L)
{
    auto* engine = getEngine(L);
    if (!engine) return 0;

    const char* trackId = luaL_checkstring(L, 1);
    const char* filePath = luaL_checkstring(L, 2);
    double startTime = luaL_checknumber(L, 3);
    double duration = luaL_checknumber(L, 4);
    double offset = luaL_optnumber(L, 5, 0.0);
    double volumeDB = luaL_optnumber(L, 6, 0.0);
    double fadeIn = luaL_optnumber(L, 7, 0.0);
    double fadeOut = luaL_optnumber(L, 8, 0.0);

    engine->addPlaybackClip(juce::String(trackId), juce::String(filePath),
                            startTime, duration, offset, volumeDB, fadeIn, fadeOut);
    return 0;
}

static int l_removePlaybackClip(lua_State* L)
{
    auto* engine = getEngine(L);
    if (!engine) return 0;

    const char* trackId = luaL_checkstring(L, 1);
    const char* filePath = luaL_checkstring(L, 2);
    engine->removePlaybackClip(juce::String(trackId), juce::String(filePath));
    return 0;
}

static int l_clearPlaybackClips(lua_State* L)
{
    auto* engine = getEngine(L);
    if (engine) engine->clearPlaybackClips();
    return 0;
}

// ============================================================================
// Send/Bus routing
// ============================================================================
static int l_addTrackSend(lua_State* L)
{
    auto* engine = getEngine(L);
    if (!engine) { lua_pushinteger(L, -1); return 1; }

    const char* srcId = luaL_checkstring(L, 1);
    const char* dstId = luaL_checkstring(L, 2);
    int idx = engine->addTrackSend(juce::String(srcId), juce::String(dstId));
    lua_pushinteger(L, idx);
    return 1;
}

static int l_removeTrackSend(lua_State* L)
{
    auto* engine = getEngine(L);
    if (!engine) return 0;

    const char* srcId = luaL_checkstring(L, 1);
    int sendIdx = (int)luaL_checkinteger(L, 2);
    engine->removeTrackSend(juce::String(srcId), sendIdx);
    return 0;
}

static int l_setTrackSendLevel(lua_State* L)
{
    auto* engine = getEngine(L);
    if (!engine) return 0;

    const char* srcId = luaL_checkstring(L, 1);
    int sendIdx = (int)luaL_checkinteger(L, 2);
    float level = (float)luaL_checknumber(L, 3);
    engine->setTrackSendLevel(juce::String(srcId), sendIdx, level);
    return 0;
}

static int l_getTrackSends(lua_State* L)
{
    auto* engine = getEngine(L);
    if (!engine) { lua_pushnil(L); return 1; }

    const char* trackId = luaL_checkstring(L, 1);
    auto sends = engine->getTrackSends(juce::String(trackId));
    pushVar(L, sends);
    return 1;
}

// ============================================================================
// S13FX (JSFX) from Lua
// ============================================================================
static int l_addTrackS13FX(lua_State* L)
{
    auto* engine = getEngine(L);
    if (!engine) { lua_pushboolean(L, 0); return 1; }

    const char* trackId = luaL_checkstring(L, 1);
    const char* scriptPath = luaL_checkstring(L, 2);
    bool isInputFX = lua_toboolean(L, 3) != 0;
    bool result = engine->addTrackS13FX(juce::String(trackId), juce::String(scriptPath), isInputFX);
    lua_pushboolean(L, result ? 1 : 0);
    return 1;
}

static int l_getAvailableS13FX(lua_State* L)
{
    auto* engine = getEngine(L);
    if (!engine) { lua_pushnil(L); return 1; }

    auto fx = engine->getAvailableS13FX();
    pushVar(L, fx);
    return 1;
}

// ============================================================================
// Plugin scanning
// ============================================================================
static int l_scanForPlugins(lua_State* L)
{
    auto* engine = getEngine(L);
    if (engine) engine->scanForPlugins();
    return 0;
}

static int l_getAvailablePlugins(lua_State* L)
{
    auto* engine = getEngine(L);
    if (!engine) { lua_pushnil(L); return 1; }

    auto plugins = engine->getAvailablePlugins();
    pushVar(L, plugins);
    return 1;
}

// ============================================================================
// ScriptEngine implementation
// ============================================================================

ScriptEngine::ScriptEngine()
{
    L = luaL_newstate();
    if (L != nullptr)
    {
        // Open standard libraries (string, math, table, io, os, etc.)
        luaL_openlibs(L);

        // Store this ScriptEngine pointer in the registry
        lua_pushlightuserdata(L, this);
        lua_setfield(L, LUA_REGISTRYINDEX, kScriptEngineKey);

        // Override global print() to route through our capture
        lua_pushcfunction(L, l_print);
        lua_setglobal(L, "print");
    }

    // Ensure user scripts directory exists
    getUserScriptsDirectory().createDirectory();
}

ScriptEngine::~ScriptEngine()
{
    if (L != nullptr)
    {
        lua_close(L);
        L = nullptr;
    }
}

void ScriptEngine::resetOutput()
{
    lastError = {};
    lastOutput = {};
}

void ScriptEngine::registerAPI(AudioEngine& engine)
{
    if (L == nullptr) return;

    // Store AudioEngine pointer in Lua registry
    lua_pushlightuserdata(L, &engine);
    lua_setfield(L, LUA_REGISTRYINDEX, kEngineKey);

    // Create the "s13" global table
    lua_newtable(L);

    // ------ Track operations ------
    auto reg = [&](const char* name, lua_CFunction fn) {
        lua_pushcfunction(L, fn);
        lua_setfield(L, -2, name);
    };

    reg("getTrackCount",    l_getTrackCount);
    reg("addTrack",         l_addTrack);
    reg("removeTrack",      l_removeTrack);
    reg("setTrackVolume",   l_setTrackVolume);
    reg("setTrackPan",      l_setTrackPan);
    reg("setTrackMute",     l_setTrackMute);
    reg("setTrackSolo",     l_setTrackSolo);
    reg("setTrackArm",      l_setTrackArm);
    reg("reorderTrack",     l_reorderTrack);

    // ------ Transport ------
    reg("play",             l_play);
    reg("stop",             l_stop);
    reg("record",           l_record);
    reg("isPlaying",        l_isPlaying);
    reg("isRecording",      l_isRecording);
    reg("getPlayhead",      l_getPlayhead);
    reg("setPlayhead",      l_setPlayhead);
    reg("getTempo",         l_getTempo);
    reg("setTempo",         l_setTempo);
    reg("getTimeSignature", l_getTimeSignature);
    reg("setTimeSignature", l_setTimeSignature);
    reg("setLoop",          l_setLoop);

    // ------ FX ------
    reg("getTrackFX",       l_getTrackFX);
    reg("getTrackInputFX",  l_getTrackInputFX);
    reg("addTrackFX",       l_addTrackFX);
    reg("removeTrackFX",    l_removeTrackFX);
    reg("bypassTrackFX",    l_bypassTrackFX);

    // ------ Master ------
    reg("setMasterVolume",  l_setMasterVolume);
    reg("getMasterVolume",  l_getMasterVolume);
    reg("setMasterPan",     l_setMasterPan);
    reg("getMasterPan",     l_getMasterPan);

    // ------ MIDI ------
    reg("getMIDIDevices",   l_getMIDIDevices);

    // ------ Metronome ------
    reg("setMetronomeEnabled", l_setMetronomeEnabled);
    reg("isMetronomeEnabled",  l_isMetronomeEnabled);

    // ------ Playback clips ------
    reg("addPlaybackClip",     l_addPlaybackClip);
    reg("removePlaybackClip",  l_removePlaybackClip);
    reg("clearPlaybackClips",  l_clearPlaybackClips);

    // ------ Sends ------
    reg("addTrackSend",        l_addTrackSend);
    reg("removeTrackSend",     l_removeTrackSend);
    reg("setTrackSendLevel",   l_setTrackSendLevel);
    reg("getTrackSends",       l_getTrackSends);

    // ------ S13FX ------
    reg("addTrackS13FX",       l_addTrackS13FX);
    reg("getAvailableS13FX",   l_getAvailableS13FX);

    // ------ Plugins ------
    reg("scanForPlugins",      l_scanForPlugins);
    reg("getAvailablePlugins", l_getAvailablePlugins);

    // ------ Utility ------
    reg("print",           l_print);
    reg("getAppVersion",   l_getAppVersion);
    reg("showMessage",     l_showMessage);

    // Set the table as global "s13"
    lua_setglobal(L, "s13");
}

bool ScriptEngine::loadAndRun(const juce::String& scriptPath)
{
    if (L == nullptr)
    {
        lastError = "Lua VM not initialized";
        return false;
    }

    resetOutput();

    // Set up the print capture
    auto prevOnPrint = onPrint;
    onPrint = [this, &prevOnPrint](const juce::String& msg) {
        if (lastOutput.isNotEmpty())
            lastOutput += "\n";
        lastOutput += msg;
        if (prevOnPrint)
            prevOnPrint(msg);
    };

    juce::File scriptFile(scriptPath);
    if (!scriptFile.existsAsFile())
    {
        lastError = "Script file not found: " + scriptPath;
        onPrint = prevOnPrint;
        return false;
    }

    juce::String code = scriptFile.loadFileAsString();
    int result = luaL_loadbuffer(L, code.toRawUTF8(), (size_t)code.getNumBytesAsUTF8(), scriptPath.toRawUTF8());
    if (result != LUA_OK)
    {
        lastError = juce::String(lua_tostring(L, -1));
        lua_pop(L, 1);
        onPrint = prevOnPrint;
        return false;
    }

    result = lua_pcall(L, 0, LUA_MULTRET, 0);
    if (result != LUA_OK)
    {
        lastError = juce::String(lua_tostring(L, -1));
        lua_pop(L, 1);
        onPrint = prevOnPrint;
        return false;
    }

    onPrint = prevOnPrint;
    return true;
}

bool ScriptEngine::executeString(const juce::String& luaCode)
{
    if (L == nullptr)
    {
        lastError = "Lua VM not initialized";
        return false;
    }

    resetOutput();

    auto prevOnPrint = onPrint;
    onPrint = [this, &prevOnPrint](const juce::String& msg) {
        if (lastOutput.isNotEmpty())
            lastOutput += "\n";
        lastOutput += msg;
        if (prevOnPrint)
            prevOnPrint(msg);
    };

    int result = luaL_loadbuffer(L, luaCode.toRawUTF8(), (size_t)luaCode.getNumBytesAsUTF8(), "=console");
    if (result != LUA_OK)
    {
        lastError = juce::String(lua_tostring(L, -1));
        lua_pop(L, 1);
        onPrint = prevOnPrint;
        return false;
    }

    result = lua_pcall(L, 0, LUA_MULTRET, 0);
    if (result != LUA_OK)
    {
        lastError = juce::String(lua_tostring(L, -1));
        lua_pop(L, 1);
        onPrint = prevOnPrint;
        return false;
    }

    onPrint = prevOnPrint;
    return true;
}

juce::File ScriptEngine::getUserScriptsDirectory()
{
    return juce::File::getSpecialLocation(juce::File::userDocumentsDirectory)
        .getChildFile("Studio13").getChildFile("Scripts");
}

juce::File ScriptEngine::getStockScriptsDirectory()
{
    return juce::File::getSpecialLocation(juce::File::currentExecutableFile)
        .getParentDirectory().getChildFile("scripts");
}

std::vector<ScriptEngine::ScriptInfo> ScriptEngine::listAvailableScripts() const
{
    std::vector<ScriptInfo> scripts;

    auto scanDir = [&scripts](const juce::File& dir, bool isStock) {
        if (!dir.isDirectory()) return;

        juce::Array<juce::File> files;
        dir.findChildFiles(files, juce::File::findFiles, true, "*.lua");

        for (const auto& file : files)
        {
            ScriptInfo info;
            info.name = file.getFileNameWithoutExtension();
            info.filePath = file.getFullPathName();
            info.isStock = isStock;

            // Try to extract description from first comment line
            juce::StringArray lines;
            file.readLines(lines);
            for (int i = 0; i < juce::jmin(lines.size(), 20); ++i)
            {
                auto line = lines[i].trim();
                if (line.startsWith("-- @desc"))
                {
                    info.description = line.fromFirstOccurrenceOf("-- @desc", false, false).trim();
                    break;
                }
                else if (line.startsWith("-- ") && info.description.isEmpty() && i == 0)
                {
                    // Use first comment as description if no @desc tag
                    info.description = line.fromFirstOccurrenceOf("-- ", false, false).trim();
                }
            }

            scripts.push_back(std::move(info));
        }
    };

    scanDir(getStockScriptsDirectory(), true);
    scanDir(getUserScriptsDirectory(), false);

    return scripts;
}
