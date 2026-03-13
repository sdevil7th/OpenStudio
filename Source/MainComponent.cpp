#include "MainComponent.h"
#include <set>
#include <thread>

#if JUCE_WINDOWS
 #ifndef NOMINMAX
  #define NOMINMAX
 #endif
 #include <windows.h>
#endif

//==============================================================================
MainComponent::MainComponent()
    : webView (juce::WebBrowserComponent::Options()
                   .withBackend (juce::WebBrowserComponent::Options::Backend::webview2)
                   .withWinWebView2Options (
                       juce::WebBrowserComponent::Options::WinWebView2()
                           .withUserDataFolder (juce::File::getSpecialLocation (juce::File::userApplicationDataDirectory)
                                                    .getChildFile ("Studio13")
                                                    .getChildFile ("WebView2UserData"))
                           .withStatusBarDisabled())
                   .withNativeIntegrationEnabled()
                   .withResourceProvider ([this] (const juce::String& url) -> std::optional<juce::WebBrowserComponent::Resource> {
                       juce::ignoreUnused(url);
                       return std::nullopt;
                   })
                   // CRITICAL: Add user script to expose native functions properly
                   .withUserScript(R"(
                       console.log("JUCE User Script: Initializing native functions...");
                       
                       // Helper to invoke native functions with timeout
                       window.__JUCE__.backend.getNativeFunction = function(name) {
                           return function(...args) {
                               return new Promise((resolve, reject) => {
                                   const resultId = Date.now() * 1000 + Math.floor(Math.random() * 1000);
                                   
                                   // Timeout after 15 seconds (audio device enumeration can take time)
                                   const timeout = setTimeout(() => {
                                       window.__JUCE__.backend.removeEventListener(listener);
                                       reject(new Error("Native function call timeout: " + name));
                                   }, 15000);

                                   const listener = window.__JUCE__.backend.addEventListener('__juce__complete', (data) => {
                                       if (data.promiseId === resultId) {
                                           clearTimeout(timeout);
                                           window.__JUCE__.backend.removeEventListener(listener);
                                           resolve(data.result);
                                       }
                                   });
                                   window.__JUCE__.backend.emitEvent('__juce__invoke', {
                                       name: name,
                                       params: args,
                                       resultId: resultId
                                   });
                               });
                           };
                       };
                       
                       // Expose functions directly as methods for easier access
                       if (window.__JUCE__.initialisationData && window.__JUCE__.initialisationData.__juce__functions) {
                           console.log("JUCE User Script: Registering functions:", window.__JUCE__.initialisationData.__juce__functions);
                           for (const funcName of window.__JUCE__.initialisationData.__juce__functions) {
                               window.__JUCE__.backend[funcName] = window.__JUCE__.backend.getNativeFunction(funcName);
                           }
                       }
                       
                       console.log("JUCE User Script: Initialization complete. Available functions:", Object.keys(window.__JUCE__.backend));
                   )")
                   .withNativeFunction ("getAudioDeviceSetup", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        juce::ignoreUnused(args);
                        // Return the current audio setup as a JSON object
                        completion (audioEngine.getAudioDeviceSetup());
                   })
                   .withNativeFunction ("setAudioDeviceSetup", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        // Expecting: [type, input, output, sampleRate, bufferSize]
                        if (args.size() == 1 && args[0].isObject()) {
                           auto* obj = args[0].getDynamicObject();
                           juce::String type = obj->getProperty("type");
                           juce::String input = obj->getProperty("inputDevice");
                           juce::String output = obj->getProperty("outputDevice");
                           double sampleRate = obj->getProperty("sampleRate");
                           int bufferSize = obj->getProperty("bufferSize");
                           
                           // Call completion immediately to avoid timeout
                           // Audio device setup will happen in background
                           completion(true);
                           
                           // Run device setup asynchronously on message thread
                           juce::MessageManager::callAsync([this, type, input, output, sampleRate, bufferSize]() {
                               audioEngine.setAudioDeviceSetup(type, input, output, sampleRate, bufferSize);
                           });
                        } else {
                           completion(false);
                        }
                   })
                   .withNativeFunction ("addTrack", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                       juce::String explicitId = "";
                       if (args.size() > 0 && args[0].isString()) {
                           explicitId = args[0].toString();
                       }
                       juce::String trackId = audioEngine.addTrack(explicitId);
                       completion(trackId);
                   })
                   .withNativeFunction ("removeTrack", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                       if (args.size() > 0 && args[0].isString())
                       {
                           bool success = audioEngine.removeTrack(args[0].toString());
                           completion(success);
                       }
                       else { completion(false); }
                   })
                   .withNativeFunction ("reorderTrack", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                       if (args.size() == 2) {
                           juce::String trackId = args[0].toString();
                           int newPosition = args[1];
                           completion(audioEngine.reorderTrack(trackId, newPosition));
                       } else {
                           completion(false);
                       }
                   })
                   .withNativeFunction ("setTrackRecordArm", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                       if (args.size() == 2) {
                           juce::String trackId = args[0].toString();
                           bool armed = args[1];
                           audioEngine.setTrackRecordArm(trackId, armed);
                           completion(true);
                       } else {
                           completion(false);
                       }
                   })
                   .withNativeFunction ("setTrackInputMonitoring", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                       if (args.size() == 2) {
                           juce::String trackId = args[0].toString();
                           bool enabled = args[1];
                           audioEngine.setTrackInputMonitoring(trackId, enabled);
                           completion(true);
                       } else {
                           completion(false);
                       }
                   })
                   .withNativeFunction ("setTrackInputChannels", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                       if (args.size() == 3) {
                           juce::String trackId = args[0].toString();
                           int startChannel = args[1];
                           int numChannels = args[2];
                           audioEngine.setTrackInputChannels(trackId, startChannel, numChannels);
                           completion(true);
                       } else {
                           completion(false);
                       }
                   })
                   .withNativeFunction ("setTrackVolume", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                       if (args.size() == 2) {
                           juce::String trackId = args[0].toString();
                           float volumeDB = args[1];
                           audioEngine.setTrackVolume(trackId, volumeDB);
                           completion(true);
                       } else {
                           completion(false);
                       }
                   })
                   .withNativeFunction ("setTrackPan", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                       if (args.size() == 2) {
                           juce::String trackId = args[0].toString();
                           float pan = args[1];
                           audioEngine.setTrackPan(trackId, pan);
                           completion(true);
                       } else {
                           completion(false);
                       }
                   })
                   .withNativeFunction ("setTrackMute", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                       if (args.size() == 2) {
                           juce::String trackId = args[0].toString();
                           bool muted = args[1];
                           audioEngine.setTrackMute(trackId, muted);
                           completion(true);
                       } else {
                           completion(false);
                       }
                   })
                   .withNativeFunction ("setTrackSolo", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                       if (args.size() == 2) {
                           juce::String trackId = args[0].toString();
                           bool soloed = args[1];
                           audioEngine.setTrackSolo(trackId, soloed);
                           completion(true);
                       } else {
                           completion(false);
                       }
                   })
                   .withNativeFunction ("setTransportPlaying", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                       if (args.size() == 1) {
                           bool playing = args[0];
                           audioEngine.setTransportPlaying(playing);
                           completion(true);
                       } else {
                           completion(false);
                       }
                   })
                   .withNativeFunction ("setTransportRecording", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                       if (args.size() == 1) {
                           bool recording = args[0];
                           audioEngine.setTransportRecording(recording);
                           completion(true);
                       } else {
                           completion(false);
                       }
                   })

                   // Punch In/Out (Phase 3.1)
                   .withNativeFunction ("setPunchRange", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                       if (args.size() == 3) {
                           double startTime = (double)args[0];
                           double endTime = (double)args[1];
                           bool enabled = (bool)args[2];
                           audioEngine.setPunchRange(startTime, endTime, enabled);
                           completion(true);
                       } else {
                           completion(false);
                       }
                   })
                   // Record-Safe (Phase 3.3)
                   .withNativeFunction ("setTrackRecordSafe", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                       if (args.size() == 2) {
                           juce::String trackId = args[0].toString();
                           bool safe = (bool)args[1];
                           audioEngine.setTrackRecordSafe(trackId, safe);
                           completion(true);
                       } else {
                           completion(false);
                       }
                   })
                   .withNativeFunction ("getTrackRecordSafe", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                       if (args.size() == 1) {
                           juce::String trackId = args[0].toString();
                           completion(audioEngine.getTrackRecordSafe(trackId));
                       } else {
                           completion(false);
                       }
                   })
                   .withNativeFunction ("getMeterLevels", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                       juce::ignoreUnused(args);
                       completion(audioEngine.getMeterLevels());
                   })
                   .withNativeFunction ("getMasterLevel", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                       juce::ignoreUnused(args);
                       completion(audioEngine.getMasterLevel());
                   })
                   // Master Controls
                   .withNativeFunction ("setMasterVolume", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                       if (args.size() == 1 && (args[0].isDouble() || args[0].isInt())) {
                           audioEngine.setMasterVolume(args[0]);
                           completion(true);
                       } else {
                           completion(false);
                       }
                   })
                   .withNativeFunction ("getMasterVolume", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                       juce::ignoreUnused(args);
                       completion(audioEngine.getMasterVolume());
                   })
                   .withNativeFunction ("setMasterPan", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                       if (args.size() == 1 && (args[0].isDouble() || args[0].isInt())) {
                           audioEngine.setMasterPan(args[0]);
                           completion(true);
                       } else {
                           completion(false);
                       }
                   })
                   .withNativeFunction ("getMasterPan", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                       juce::ignoreUnused(args);
                       completion(audioEngine.getMasterPan());
                   })
                   .withNativeFunction ("setMasterMono", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                       if (args.size() == 1) {
                           audioEngine.setMasterMono(static_cast<bool>(args[0]));
                           completion(true);
                       } else {
                           completion(false);
                       }
                   })
                   .withNativeFunction ("getMasterMono", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                       juce::ignoreUnused(args);
                       completion(audioEngine.getMasterMono());
                   })
                   .withNativeFunction ("addMasterFX", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                       if (args.size() == 1) {
                           juce::String pluginPath = args[0].toString();
                           bool success = audioEngine.addMasterFX(pluginPath);
                           completion(success);
                       } else {
                           completion(false);
                       }
                   })
                   .withNativeFunction ("getMasterFX", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                       juce::ignoreUnused(args);
                       completion(audioEngine.getMasterFX());
                   })
                   .withNativeFunction ("removeMasterFX", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                       if (args.size() == 1 && (args[0].isInt() || args[0].isDouble())) {
                           audioEngine.removeMasterFX((int)args[0]);
                           completion(true);
                       } else {
                           completion(false);
                       }
                   })
                   .withNativeFunction ("openMasterFXEditor", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                       if (args.size() == 1 && (args[0].isInt() || args[0].isDouble())) {
                           audioEngine.openMasterFXEditor((int)args[0]);
                           completion(true);
                       } else {
                           completion(false);
                       }
                   })
                   // Monitoring FX Management (Phase 2.6)
                   .withNativeFunction ("addMonitoringFX", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                       if (args.size() == 1) {
                           juce::String pluginPath = args[0].toString();
                           bool success = audioEngine.addMonitoringFX(pluginPath);
                           completion(success);
                       } else {
                           completion(false);
                       }
                   })
                   .withNativeFunction ("getMonitoringFX", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                       juce::ignoreUnused(args);
                       completion(audioEngine.getMonitoringFX());
                   })
                   .withNativeFunction ("removeMonitoringFX", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                       if (args.size() == 1 && (args[0].isInt() || args[0].isDouble())) {
                           audioEngine.removeMonitoringFX((int)args[0]);
                           completion(true);
                       } else {
                           completion(false);
                       }
                   })
                   .withNativeFunction ("openMonitoringFXEditor", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                       if (args.size() == 1 && (args[0].isInt() || args[0].isDouble())) {
                           audioEngine.openMonitoringFXEditor((int)args[0]);
                           completion(true);
                       } else {
                           completion(false);
                       }
                   })
                   .withNativeFunction ("bypassMonitoringFX", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                       if (args.size() == 2) {
                           audioEngine.bypassMonitoringFX((int)args[0], (bool)args[1]);
                           completion(true);
                       } else {
                           completion(false);
                       }
                   })
                   // Plugin Management
                   .withNativeFunction ("scanForPlugins", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                       juce::ignoreUnused(args);
                       juce::Logger::writeToLog("MainComponent: scanForPlugins called from frontend");
                       audioEngine.scanForPlugins();
                       int numPlugins = audioEngine.getAvailablePlugins().size();
                       juce::String message = "Scan complete!\nFound " + juce::String(numPlugins) + " plugins.";
                       juce::AlertWindow::showMessageBoxAsync(juce::AlertWindow::InfoIcon, "Plugin Scan", message);
                       juce::Logger::writeToLog("MainComponent: Scan complete. Found " + juce::String(numPlugins) + " plugins");
                       completion(true);
                   })
                   .withNativeFunction ("getAvailablePlugins", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                       juce::ignoreUnused(args);
                       completion(audioEngine.getAvailablePlugins());
                   })
                   .withNativeFunction ("addTrackInputFX", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                       if (args.size() >= 2) {
                           juce::String trackId = args[0].toString();
                           juce::String pluginPath = args[1].toString();
                           bool openEditor = args.size() >= 3 ? (bool)args[2] : true;
                           bool success = audioEngine.addTrackInputFX(trackId, pluginPath, openEditor);
                           completion(success);
                       } else {
                           completion(false);
                       }
                   })
                   .withNativeFunction ("addTrackFX", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                       if (args.size() >= 2) {
                           juce::String trackId = args[0].toString();
                           juce::String pluginPath = args[1].toString();
                           bool openEditor = args.size() >= 3 ? (bool)args[2] : true;
                           bool success = audioEngine.addTrackFX(trackId, pluginPath, openEditor);
                           completion(success);
                       } else {
                           completion(false);
                       }
                   })
                   .withNativeFunction ("openPluginEditor", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                       if (args.size() == 3) {
                           juce::String trackId = args[0].toString();
                           int fxIndex = args[1];
                           bool isInputFX = args[2];
                           audioEngine.openPluginEditor(trackId, fxIndex, isInputFX);
                           completion(true);
                       } else {
                           completion(false);
                       }
                   })
                   .withNativeFunction ("closePluginEditor", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                       if (args.size() == 3) {
                           juce::String trackId = args[0].toString();
                           int fxIndex = args[1];
                           bool isInputFX = args[2];
                           audioEngine.closePluginEditor(trackId, fxIndex, isInputFX);
                            completion(true);
                        } else {
                            completion(false);
                        }
                    })
                    .withNativeFunction ("closeAllPluginWindows", [this] (const juce::Array<juce::var>&, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        audioEngine.closeAllPluginWindows();
                        completion(true);
                    })
                    // Built-in FX Preset System
                    .withNativeFunction ("getBuiltInFXPresets", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        auto pluginName = args[0].toString();
                        completion(audioEngine.getBuiltInFXPresets(pluginName));
                    })
                    .withNativeFunction ("saveBuiltInFXPreset", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        auto trackId = args[0].toString();
                        auto fxIndex = static_cast<int>(args[1]);
                        auto isInputFX = static_cast<bool>(args[2]);
                        auto presetName = args[3].toString();
                        completion(audioEngine.saveBuiltInFXPreset(trackId, fxIndex, isInputFX, presetName));
                    })
                    .withNativeFunction ("loadBuiltInFXPreset", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        auto trackId = args[0].toString();
                        auto fxIndex = static_cast<int>(args[1]);
                        auto isInputFX = static_cast<bool>(args[2]);
                        auto presetName = args[3].toString();
                        completion(audioEngine.loadBuiltInFXPreset(trackId, fxIndex, isInputFX, presetName));
                    })
                    .withNativeFunction ("deleteBuiltInFXPreset", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        auto pluginName = args[0].toString();
                        auto presetName = args[1].toString();
                        completion(audioEngine.deleteBuiltInFXPreset(pluginName, presetName));
                    })
                    // FX Chain Query and Management
                    .withNativeFunction ("getTrackInputFX", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        if (args.size() == 1) {
                            juce::String trackId = args[0].toString();
                            completion(audioEngine.getTrackInputFX(trackId));
                        } else {
                            completion(juce::Array<juce::var>());
                        }
                    })
                    .withNativeFunction ("getTrackFX", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        if (args.size() == 1) {
                            juce::String trackId = args[0].toString();
                            completion(audioEngine.getTrackFX(trackId));
                        } else {
                            completion(juce::Array<juce::var>());
                        }
                    })
                    .withNativeFunction ("getPluginParameters", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        if (args.size() == 3 && args[0].isString()) {
                            juce::String trackId = args[0].toString();
                            int fxIndex = static_cast<int>(args[1]);
                            bool isInputFX = static_cast<bool>(args[2]);
                            completion(audioEngine.getPluginParameters(trackId, fxIndex, isInputFX));
                        } else {
                            completion(juce::Array<juce::var>());
                        }
                    })
                    .withNativeFunction ("removeTrackInputFX", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        if (args.size() == 2 && args[1].isInt()) {
                            juce::String trackId = args[0].toString();
                            audioEngine.removeTrackInputFX(trackId, args[1]);
                            completion(true);
                        } else {
                            completion(false);
                        }
                    })
                    .withNativeFunction ("removeTrackFX", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        if (args.size() == 2 && args[1].isInt()) {
                            juce::String trackId = args[0].toString();
                            audioEngine.removeTrackFX(trackId, args[1]);
                            completion(true);
                        } else {
                            completion(false);
                        }
                    })
                    .withNativeFunction ("bypassTrackInputFX", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        if (args.size() == 3 && args[1].isInt() && args[2].isBool()) {
                            juce::String trackId = args[0].toString();
                            audioEngine.bypassTrackInputFX(trackId, args[1], args[2]);
                            completion(true);
                        } else {
                            completion(false);
                        }
                    })
                    .withNativeFunction ("bypassTrackFX", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        if (args.size() == 3 && args[1].isInt() && args[2].isBool()) {
                            juce::String trackId = args[0].toString();
                            audioEngine.bypassTrackFX(trackId, args[1], args[2]);
                            completion(true);
                        } else {
                            completion(false);
                        }
                    })
                    .withNativeFunction ("reorderTrackInputFX", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        if (args.size() == 3 && args[1].isInt() && args[2].isInt()) {
                            juce::String trackId = args[0].toString();
                            int fromIndex = args[1];
                            int toIndex = args[2];
                            bool success = audioEngine.reorderTrackInputFX(trackId, fromIndex, toIndex);
                            completion(success);
                        } else {
                            completion(false);
                        }
                    })
                    .withNativeFunction ("reorderTrackFX", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        if (args.size() == 3 && args[1].isInt() && args[2].isInt()) {
                            juce::String trackId = args[0].toString();
                            int fromIndex = args[1];
                            int toIndex = args[2];
                            bool success = audioEngine.reorderTrackFX(trackId, fromIndex, toIndex);
                            completion(success);
                        } else {
                            completion(false);
                        }
                    })
                   // S13FX (JSFX) Management
                   .withNativeFunction ("addTrackS13FX", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                       if (args.size() >= 2) {
                           juce::String trackId = args[0].toString();
                           juce::String scriptPath = args[1].toString();
                           bool isInputFX = args.size() >= 3 ? (bool)args[2] : false;
                           bool success = audioEngine.addTrackS13FX(trackId, scriptPath, isInputFX);
                           completion(success);
                       } else {
                           completion(false);
                       }
                   })
                   .withNativeFunction ("addMasterS13FX", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                       if (args.size() >= 1) {
                           juce::String scriptPath = args[0].toString();
                           bool success = audioEngine.addMasterS13FX(scriptPath);
                           completion(success);
                       } else {
                           completion(false);
                       }
                   })
                   .withNativeFunction ("getS13FXSliders", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                       if (args.size() >= 3) {
                           juce::String trackId = args[0].toString();
                           int fxIndex = args[1];
                           bool isInputFX = args[2];
                           completion(audioEngine.getS13FXSliders(trackId, fxIndex, isInputFX));
                       } else {
                           completion(juce::Array<juce::var>());
                       }
                   })
                   .withNativeFunction ("setS13FXSlider", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                       if (args.size() >= 5) {
                           juce::String trackId = args[0].toString();
                           int fxIndex = args[1];
                           bool isInputFX = args[2];
                           int sliderIndex = args[3];
                           double value = args[4];
                           bool success = audioEngine.setS13FXSlider(trackId, fxIndex, isInputFX, sliderIndex, value);
                           completion(success);
                       } else {
                           completion(false);
                       }
                   })
                   .withNativeFunction ("reloadS13FX", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                       if (args.size() >= 3) {
                           juce::String trackId = args[0].toString();
                           int fxIndex = args[1];
                           bool isInputFX = args[2];
                           bool success = audioEngine.reloadS13FX(trackId, fxIndex, isInputFX);
                           completion(success);
                       } else {
                           completion(false);
                       }
                   })
                   .withNativeFunction ("getAvailableS13FX", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                       juce::ignoreUnused(args);
                       completion(audioEngine.getAvailableS13FX());
                   })
                   .withNativeFunction ("openUserEffectsFolder", [] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                       juce::ignoreUnused(args);
                       auto userDir = PluginManager::getUserEffectsDirectory();
                       userDir.createDirectory();
                       userDir.revealToUser();
                       completion(true);
                   })
                   // Lua Scripting (S13Script)
                   .withNativeFunction ("runScript", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                       if (args.size() >= 1) {
                           juce::String scriptPath = args[0].toString();
                           completion(audioEngine.runScript(scriptPath));
                       } else {
                           auto* err = new juce::DynamicObject();
                           err->setProperty("success", false);
                           err->setProperty("error", "Missing scriptPath argument");
                           err->setProperty("output", "");
                           completion(juce::var(err));
                       }
                   })
                   .withNativeFunction ("runScriptCode", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                       if (args.size() >= 1) {
                           juce::String code = args[0].toString();
                           completion(audioEngine.runScriptCode(code));
                       } else {
                           auto* err = new juce::DynamicObject();
                           err->setProperty("success", false);
                           err->setProperty("error", "Missing code argument");
                           err->setProperty("output", "");
                           completion(juce::var(err));
                       }
                   })
                   .withNativeFunction ("getScriptDirectory", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                       juce::ignoreUnused(args);
                       completion(audioEngine.getScriptDirectory());
                   })
                   .withNativeFunction ("listScripts", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                       juce::ignoreUnused(args);
                       completion(audioEngine.listScripts());
                   })
                   // Transport Position
                   .withNativeFunction ("getTransportPosition", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                       juce::ignoreUnused(args);
                       completion(audioEngine.getTransportPosition());
                   })
                   .withNativeFunction ("setTransportPosition", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                       if (args.size() == 1) {
                           double seconds = args[0];
                           audioEngine.setTransportPosition(seconds);
                           completion(true);
                       } else {
                           completion(false);
                       }
                   })
                   // Tempo Control
                   .withNativeFunction ("setTempo", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                       if (args.size() == 1) {
                           double bpm = args[0];
                           audioEngine.setTempo(bpm);
                           completion(true);
                       } else {
                           completion(false);
                       }
                   })
                   .withNativeFunction ("getTempo", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                       juce::ignoreUnused(args);
                       completion(audioEngine.getTempo());
                   })
                    // Metronome & Time Signature (Phase 3)
                    .withNativeFunction ("setMetronomeEnabled", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        if (args.size() == 1 && args[0].isBool()) {
                            audioEngine.setMetronomeEnabled(args[0]);
                            completion(true);
                        } else {
                            completion(false);
                        }
                    })
                    .withNativeFunction ("setMetronomeVolume", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        if (args.size() == 1 && (args[0].isDouble() || args[0].isInt())) {
                            audioEngine.setMetronomeVolume(args[0]);
                            completion(true);
                        } else {
                            completion(false);
                        }
                    })
                    .withNativeFunction ("isMetronomeEnabled", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        juce::ignoreUnused(args);
                        completion(audioEngine.isMetronomeEnabled());
                    })
                    .withNativeFunction ("setMetronomeAccentBeats", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                         if (args.size() == 1 && args[0].isArray()) {
                             auto* arr = args[0].getArray();
                             std::vector<bool> accents;
                             for (const auto& item : *arr) {
                                 accents.push_back(item);
                             }
                             audioEngine.setMetronomeAccentBeats(accents);
                             completion(true);
                         } else {
                             completion(false);
                         }
                    })
                    .withNativeFunction ("renderMetronomeToFile", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        if (args.size() == 2 && (args[0].isDouble() || args[0].isInt()) && (args[1].isDouble() || args[1].isInt())) {
                            double startTime = (double)args[0];
                            double endTime = (double)args[1];
                            juce::String filePath = audioEngine.renderMetronomeToFile(startTime, endTime);
                            completion(filePath);
                        } else {
                            completion(juce::String(""));
                        }
                    })
                    .withNativeFunction ("setTimeSignature", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        if (args.size() == 2 && args[0].isInt() && args[1].isInt()) {
                            audioEngine.setTimeSignature(args[0], args[1]);
                            completion(true);
                        } else {
                            completion(false);
                        }
                    })
                    .withNativeFunction ("getTimeSignature", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        juce::ignoreUnused(args);
                        juce::DynamicObject* result = new juce::DynamicObject();
                        int num, den;
                        audioEngine.getTimeSignature(num, den);
                        result->setProperty("numerator", num);
                        result->setProperty("denominator", den);
                        completion(result);
                    })
                    // Recording
                    .withNativeFunction ("getLastCompletedClips", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        juce::ignoreUnused(args);
                        auto clips = audioEngine.getLastCompletedClips();
                        juce::Array<juce::var> clipArray;
                        
                        for (const auto& clip : clips)
                        {
                            juce::DynamicObject* clipObj = new juce::DynamicObject();
                            clipObj->setProperty("trackId", clip.trackId);
                            clipObj->setProperty("filePath", clip.file.getFullPathName());
                            clipObj->setProperty("startTime", clip.startTime);
                            clipObj->setProperty("duration", clip.duration);
                            clipArray.add(clipObj);
                        }
                        
                        completion(clipArray);
                    })
                    .withNativeFunction ("getLastCompletedMIDIClips", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        juce::ignoreUnused(args);
                        auto clips = audioEngine.getLastCompletedMIDIClips();
                        juce::Array<juce::var> clipArray;

                        for (const auto& clip : clips)
                        {
                            juce::DynamicObject* clipObj = new juce::DynamicObject();
                            clipObj->setProperty("trackId", clip.trackId);
                            clipObj->setProperty("startTime", clip.startTime);
                            clipObj->setProperty("duration", clip.duration);
                            if (clip.midiFile.existsAsFile())
                                clipObj->setProperty("filePath", clip.midiFile.getFullPathName());

                            // Serialize MIDI events as JSON array
                            juce::Array<juce::var> eventsArray;
                            for (const auto& evt : clip.events)
                            {
                                juce::DynamicObject* evtObj = new juce::DynamicObject();
                                evtObj->setProperty("timestamp", evt.timestamp);

                                if (evt.message.isNoteOn())
                                {
                                    evtObj->setProperty("type", "noteOn");
                                    evtObj->setProperty("note", evt.message.getNoteNumber());
                                    evtObj->setProperty("velocity", evt.message.getVelocity());
                                    evtObj->setProperty("channel", evt.message.getChannel());
                                }
                                else if (evt.message.isNoteOff())
                                {
                                    evtObj->setProperty("type", "noteOff");
                                    evtObj->setProperty("note", evt.message.getNoteNumber());
                                    evtObj->setProperty("velocity", 0);
                                    evtObj->setProperty("channel", evt.message.getChannel());
                                }
                                else if (evt.message.isController())
                                {
                                    evtObj->setProperty("type", "cc");
                                    evtObj->setProperty("controller", evt.message.getControllerNumber());
                                    evtObj->setProperty("value", evt.message.getControllerValue());
                                    evtObj->setProperty("channel", evt.message.getChannel());
                                }
                                else if (evt.message.isPitchWheel())
                                {
                                    evtObj->setProperty("type", "pitchBend");
                                    evtObj->setProperty("value", evt.message.getPitchWheelValue());
                                    evtObj->setProperty("channel", evt.message.getChannel());
                                }
                                else
                                {
                                    continue;  // Skip unsupported event types
                                }

                                eventsArray.add(evtObj);
                            }
                            clipObj->setProperty("events", eventsArray);

                            clipArray.add(clipObj);
                        }

                        completion(clipArray);
                    })
                   // Waveform Visualization
                   .withNativeFunction ("getWaveformPeaks", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                       // args: [filePath, samplesPerPixel, startSample, numPixels]
                       // Legacy 3-arg form also accepted (startSample=0)
                       if (args.size() >= 3) {
                           juce::String filePath = args[0].toString();
                           int samplesPerPixel = args[1];
                           int startSample = (args.size() >= 4) ? static_cast<int>(args[2]) : 0;
                           int numPixels = (args.size() >= 4) ? static_cast<int>(args[3]) : static_cast<int>(args[2]);
                           completion(audioEngine.getWaveformPeaks(filePath, samplesPerPixel, startSample, numPixels));
                       } else {
                           completion(juce::Array<juce::var>());
                       }
                   })
                   .withNativeFunction ("getRecordingPeaks", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                       if (args.size() == 3) {
                           juce::String trackId = args[0].toString();
                           int samplesPerPixel = args[1];
                           int numPixels = args[2];
                           completion(audioEngine.getRecordingPeaks(trackId, samplesPerPixel, numPixels));
                       } else {
                           completion(juce::Array<juce::var>());
                       }
                   })
                   // Playback clip management
                   .withNativeFunction ("addPlaybackClip", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        // Accepts 4-9 args: trackId, filePath, startTime, duration, [offset], [volumeDB], [fadeIn], [fadeOut], [clipId]
                        // Note: numeric args can be int or double depending on JS value serialization
                        if (args.size() >= 4 && args[1].isString()) {
                            juce::String trackId = args[0].toString();
                            juce::String filePath = args[1].toString();
                            double startTime = (double)args[2];
                            double duration = (double)args[3];
                            double offset = args.size() > 4 ? (double)args[4] : 0.0;
                            double volumeDB = args.size() > 5 ? (double)args[5] : 0.0;
                            double fadeIn = args.size() > 6 ? (double)args[6] : 0.0;
                            double fadeOut = args.size() > 7 ? (double)args[7] : 0.0;
                            juce::String clipId = args.size() > 8 ? args[8].toString() : juce::String();
                            audioEngine.addPlaybackClip(trackId, filePath, startTime, duration, offset, volumeDB, fadeIn, fadeOut, clipId);
                            completion(true);
                        } else {
                            completion(false);
                        }
                    })
                   .withNativeFunction ("removePlaybackClip", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        if (args.size() == 2 && args[1].isString()) {
                            juce::String trackId = args[0].toString();
                            juce::String filePath = args[1].toString();
                            audioEngine.removePlaybackClip(trackId, filePath);
                            completion(true);
                        } else {
                            completion(false);
                        }
                    })
                   .withNativeFunction ("addPlaybackClipsBatch", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        if (args.size() >= 1 && args[0].isString())
                        {
                            audioEngine.addPlaybackClipsBatch (args[0].toString());
                            completion (true);
                        }
                        else
                            completion (false);
                    })
                   .withNativeFunction ("clearPlaybackClips", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        juce::ignoreUnused(args);
                        audioEngine.clearPlaybackClips();
                        completion(true);
                    })
                    // MIDI Device Management (Phase 2)
                    .withNativeFunction ("getMIDIInputDevices", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        juce::ignoreUnused(args);
                        completion(audioEngine.getMIDIInputDevices());
                    })
                    .withNativeFunction ("openMIDIDevice", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        if (args.size() == 1 && args[0].isString()) {
                            juce::String deviceName = args[0].toString();
                            completion(audioEngine.openMIDIDevice(deviceName));
                        } else {
                            completion(false);
                        }
                    })
                    .withNativeFunction ("closeMIDIDevice", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        if (args.size() == 1 && args[0].isString()) {
                            juce::String deviceName = args[0].toString();
                            audioEngine.closeMIDIDevice(deviceName);
                            completion(true);
                        } else {
                            completion(false);
                        }
                    })
                    .withNativeFunction ("getOpenMIDIDevices", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        juce::ignoreUnused(args);
                        completion(audioEngine.getOpenMIDIDevices());
                    })
                    // Track Type Management (Phase 2)
                    .withNativeFunction ("setTrackType", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        if (args.size() == 2 && args[0].isString() && args[1].isString()) {
                            juce::String trackId = args[0].toString();
                            juce::String type = args[1].toString();
                            audioEngine.setTrackType(trackId, type);
                            completion(true);
                        } else {
                            completion(false);
                        }
                    })
                    .withNativeFunction ("setTrackMIDIInput", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        if (args.size() == 3 && args[0].isString() && args[1].isString() && args[2].isInt()) {
                            juce::String trackId = args[0].toString();
                            juce::String deviceName = args[1].toString();
                            int channel = args[2];
                            audioEngine.setTrackMIDIInput(trackId, deviceName, channel);
                            completion(true);
                        } else {
                            completion(false);
                        }
                    })
                    .withNativeFunction ("loadInstrument", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        if (args.size() == 2 && args[0].isString() && args[1].isString()) {
                            juce::String trackId = args[0].toString();
                            juce::String vstPath = args[1].toString();
                            completion(audioEngine.loadInstrument(trackId, vstPath));
                        } else {
                            completion(false);
                        }
                    })
                    .withNativeFunction ("openInstrumentEditor", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        if (args.size() == 1 && args[0].isString()) {
                            juce::String trackId = args[0].toString();
                            audioEngine.openInstrumentEditor(trackId);
                            completion(true);
                        } else {
                            completion(false);
                        }
                    })
                    // ========== Project Save/Load (F2) ==========
                    .withNativeFunction ("showSaveDialog", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        // Show native save file dialog
                        // Args: [defaultPath (optional), title (optional)]
                        juce::String defaultPath = args.size() > 0 ? args[0].toString() : "";
                        juce::String title = args.size() > 1 ? args[1].toString() : "Save Project";
                        
                        juce::File initialDir = defaultPath.isNotEmpty() 
                            ? juce::File(defaultPath).getParentDirectory()
                            : juce::File::getSpecialLocation(juce::File::userDocumentsDirectory);
                        juce::String initialFileName = defaultPath.isNotEmpty()
                            ? juce::File(defaultPath).getFileName()
                            : "Untitled.s13";
                        
                        // Use async file chooser
                        fileChooser = std::make_unique<juce::FileChooser>(
                            title,
                            initialDir.getChildFile(initialFileName),
                            "*.s13",
                            true  // Use native dialog
                        );
                        
                        auto chooserFlags = juce::FileBrowserComponent::saveMode | juce::FileBrowserComponent::canSelectFiles;

                        fileChooser->launchAsync(chooserFlags, [completion](const juce::FileChooser& fc) {
                            auto result = fc.getResult();
                            if (result.getFullPathName().isNotEmpty()) {
                                // Ensure .s13 extension
                                juce::String path = result.getFullPathName();
                                if (!path.endsWithIgnoreCase(".s13")) {
                                    path += ".s13";
                                }
                                completion(path);
                            } else {
                                completion("");  // User cancelled
                            }
                        });
                    })
                    .withNativeFunction ("showOpenDialog", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        // Show native open file dialog
                        // Args: [title (optional)]
                        juce::String title = args.size() > 0 ? args[0].toString() : "Open Project";

                        juce::File initialDir = juce::File::getSpecialLocation(juce::File::userDocumentsDirectory);

                        fileChooser = std::make_unique<juce::FileChooser>(
                            title,
                            initialDir,
                            "*.s13",
                            true  // Use native dialog
                        );

                        auto chooserFlags = juce::FileBrowserComponent::openMode | juce::FileBrowserComponent::canSelectFiles;
                        
                        fileChooser->launchAsync(chooserFlags, [completion](const juce::FileChooser& fc) {
                            auto result = fc.getResult();
                            if (result.existsAsFile()) {
                                completion(result.getFullPathName());
                            } else {
                                completion("");  // User cancelled
                            }
                        });
                    })
                    .withNativeFunction ("saveProjectToFile", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        // Save project JSON to file
                        // Args: [filePath, jsonContent]
                        if (args.size() == 2 && args[0].isString() && args[1].isString()) {
                            juce::String filePath = args[0].toString();
                            juce::String jsonContent = args[1].toString();
                            
                            juce::File file(filePath);
                            bool success = file.replaceWithText(jsonContent);
                            
                            if (success) {
                                juce::Logger::writeToLog("Project saved to: " + filePath);
                            } else {
                                juce::Logger::writeToLog("Failed to save project to: " + filePath);
                            }
                            
                            completion(success);
                        } else {
                            completion(false);
                        }
                    })
                    .withNativeFunction ("loadProjectFromFile", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        // Load project JSON from file
                        // Args: [filePath]
                        if (args.size() == 1 && args[0].isString()) {
                            juce::String filePath = args[0].toString();
                            juce::File file(filePath);
                            
                            if (file.existsAsFile()) {
                                juce::String jsonContent = file.loadFileAsString();
                                juce::Logger::writeToLog("Project loaded from: " + filePath + " (" + juce::String(jsonContent.length()) + " chars)");
                                completion(jsonContent);
                            } else {
                                juce::Logger::writeToLog("Project file not found: " + filePath);
                                completion("");
                            }
                        } else {
                            completion("");
                        }
                    })
                    .withNativeFunction ("getPluginState", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        // Get plugin state as base64 string
                        // Args: [trackId, fxIndex, isInputFX]
                        if (args.size() == 3) {
                            juce::String trackId = args[0].toString();
                            int fxIndex = args[1];
                            bool isInputFX = args[2];
                            juce::String state = audioEngine.getPluginState(trackId, fxIndex, isInputFX);
                            completion(state);
                        } else {
                            completion("");
                        }
                    })
                    .withNativeFunction ("setPluginState", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        // Set plugin state from base64 string
                        // Args: [trackId, fxIndex, isInputFX, base64State]
                        if (args.size() == 4) {
                            juce::String trackId = args[0].toString();
                            int fxIndex = args[1];
                            bool isInputFX = args[2];
                            juce::String base64State = args[3].toString();
                            bool success = audioEngine.setPluginState(trackId, fxIndex, isInputFX, base64State);
                            completion(success);
                        } else {
                            completion(false);
                        }
                    })
                    .withNativeFunction ("getMasterPluginState", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        // Get master FX plugin state as base64
                        // Args: [fxIndex]
                        if (args.size() == 1) {
                            int fxIndex = args[0];
                            juce::String state = audioEngine.getMasterPluginState(fxIndex);
                            completion(state);
                        } else {
                            completion("");
                        }
                    })
                    .withNativeFunction ("setMasterPluginState", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        // Set master FX plugin state from base64
                        // Args: [fxIndex, base64State]
                        if (args.size() == 2) {
                            int fxIndex = args[0];
                            juce::String base64State = args[1].toString();
                            bool success = audioEngine.setMasterPluginState(fxIndex, base64State);
                            completion(success);
                        } else {
                            completion(false);
                        }
                    })
                    .withNativeFunction ("importMediaFile", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        // Read audio file metadata (duration, sample rate, channels, format).
                        // For video files that JUCE can't read directly, attempts FFmpeg extraction.
                        // Args: [filePath]
                        if (args.size() >= 1 && args[0].isString()) {
                            juce::String filePath = args[0].toString();
                            juce::File audioFile(filePath);

                            if (!audioFile.existsAsFile()) {
                                juce::Logger::writeToLog("importMediaFile: File not found: " + filePath);
                                completion(juce::var());
                                return;
                            }

                            juce::AudioFormatManager formatManager;
                            formatManager.registerBasicFormats();

                            std::unique_ptr<juce::AudioFormatReader> reader(formatManager.createReaderFor(audioFile));

                            // If JUCE can't read the file directly, try FFmpeg audio extraction
                            // (handles video containers like .mp4, .mkv, .avi, .mov, .webm)
                            juce::File extractedFile;
                            if (!reader) {
                                juce::String ext = audioFile.getFileExtension().toLowerCase();
                                bool isVideoFormat = (ext == ".mp4" || ext == ".mkv" || ext == ".avi" ||
                                                      ext == ".mov" || ext == ".webm" || ext == ".wmv" ||
                                                      ext == ".flv" || ext == ".m4v");

                                if (isVideoFormat) {
                                    juce::Logger::writeToLog("importMediaFile: Attempting FFmpeg audio extraction for: " + filePath);

                                    juce::File tempDir = juce::File::getSpecialLocation(juce::File::tempDirectory)
                                                             .getChildFile("Studio13-imports");
                                    tempDir.createDirectory();
                                    extractedFile = tempDir.getChildFile(audioFile.getFileNameWithoutExtension() + "_audio.wav");

                                    // Find FFmpeg: check next to executable first, then fall back to PATH
                                    juce::File appDir = juce::File::getSpecialLocation(juce::File::currentExecutableFile).getParentDirectory();
                                    juce::File bundledFFmpeg = appDir.getChildFile("ffmpeg.exe");
                                    juce::String ffmpegPath = bundledFFmpeg.existsAsFile() ? bundledFFmpeg.getFullPathName() : "ffmpeg";

                                    // Run FFmpeg to extract audio as WAV
                                    juce::String cmd = "\"" + ffmpegPath + "\" -y -i \"" + filePath + "\" -vn -acodec pcm_s16le -ar 44100 -ac 2 \"" + extractedFile.getFullPathName() + "\"";

                                    juce::ChildProcess ffmpeg;
                                    bool started = ffmpeg.start(cmd);

                                    if (started) {
                                        // Wait up to 60 seconds for extraction
                                        bool finished = ffmpeg.waitForProcessToFinish(60000);
                                        auto exitCode = ffmpeg.getExitCode();

                                        if (finished && exitCode == 0 && extractedFile.existsAsFile()) {
                                            juce::Logger::writeToLog("importMediaFile: FFmpeg extracted audio to: " + extractedFile.getFullPathName());
                                            reader.reset(formatManager.createReaderFor(extractedFile));
                                        } else {
                                            juce::Logger::writeToLog("importMediaFile: FFmpeg extraction failed (exit code: " + juce::String(exitCode) + ")");
                                        }
                                    } else {
                                        juce::Logger::writeToLog("importMediaFile: FFmpeg not found. Install FFmpeg and add it to PATH to import video files.");
                                    }
                                }
                            }

                            if (!reader) {
                                juce::Logger::writeToLog("importMediaFile: Unsupported format: " + filePath);
                                completion(juce::var());
                                return;
                            }

                            double duration = reader->lengthInSamples / reader->sampleRate;

                            // Use the extracted file path if we did FFmpeg conversion
                            juce::String resultFilePath = extractedFile.existsAsFile() ? extractedFile.getFullPathName() : filePath;

                            juce::DynamicObject::Ptr result = new juce::DynamicObject();
                            result->setProperty("filePath", resultFilePath);
                            result->setProperty("duration", duration);
                            result->setProperty("sampleRate", (int)reader->sampleRate);
                            result->setProperty("numChannels", (int)reader->numChannels);
                            result->setProperty("format", audioFile.getFileExtension().toUpperCase().trimCharactersAtStart("."));

                            juce::Logger::writeToLog("importMediaFile: " + resultFilePath + " - " + juce::String(duration) + "s, " + juce::String((int)reader->sampleRate) + "Hz, " + juce::String((int)reader->numChannels) + "ch");
                            completion(juce::var(result.get()));
                        } else {
                            completion(juce::var());
                        }
                    })
                    .withNativeFunction ("saveDroppedFile", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        // Save a base64-encoded file dropped from the OS to a temp directory.
                        // Args: [fileName, base64Data]
                        // Returns: the full path to the saved file, or empty string on failure.
                        if (args.size() >= 2 && args[0].isString() && args[1].isString()) {
                            juce::String fileName = args[0].toString();
                            juce::String base64Data = args[1].toString();

                            // Decode standard base64 (from JS btoa()) to binary
                            // Note: MemoryBlock::fromBase64Encoding uses JUCE's non-standard format,
                            // so we must use Base64::convertFromBase64 for standard base64.
                            juce::MemoryOutputStream decoded;
                            if (!juce::Base64::convertFromBase64(decoded, base64Data)) {
                                juce::Logger::writeToLog("saveDroppedFile: Failed to decode base64 for: " + fileName);
                                completion(juce::String(""));
                                return;
                            }

                            // Save to app temp directory
                            juce::File tempDir = juce::File::getSpecialLocation(juce::File::tempDirectory)
                                                     .getChildFile("Studio13-imports");
                            tempDir.createDirectory();

                            juce::File destFile = tempDir.getChildFile(fileName);
                            // Avoid overwriting — add a number suffix if the file exists
                            if (destFile.existsAsFile()) {
                                juce::String baseName = destFile.getFileNameWithoutExtension();
                                juce::String ext = destFile.getFileExtension();
                                int counter = 1;
                                while (destFile.existsAsFile()) {
                                    destFile = tempDir.getChildFile(baseName + "_" + juce::String(counter) + ext);
                                    counter++;
                                }
                            }

                            const auto& data = decoded.getMemoryBlock();
                            if (destFile.replaceWithData(data.getData(), data.getSize())) {
                                juce::Logger::writeToLog("saveDroppedFile: Saved " + juce::String((int)data.getSize()) + " bytes to " + destFile.getFullPathName());
                                completion(destFile.getFullPathName());
                            } else {
                                juce::Logger::writeToLog("saveDroppedFile: Failed to write file: " + destFile.getFullPathName());
                                completion(juce::String(""));
                            }
                        } else {
                            juce::Logger::writeToLog("saveDroppedFile: Invalid arguments (expected 2 strings, got " + juce::String(args.size()) + " args)");
                            completion(juce::String(""));
                        }
                    })
                    .withNativeFunction ("showRenderSaveDialog", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        // Show save dialog for render/export with audio format filter
                        // Args: [defaultFileName, formatExtension]
                        juce::String defaultFileName = args.size() > 0 ? args[0].toString() : "untitled";
                        juce::String formatExt = args.size() > 1 ? args[1].toString() : "wav";

                        juce::File initialDir = juce::File::getSpecialLocation(juce::File::userDocumentsDirectory);
                        juce::String filter = "*." + formatExt;
                        juce::String fullFileName = defaultFileName + "." + formatExt;

                        fileChooser = std::make_unique<juce::FileChooser>(
                            "Export Audio",
                            initialDir.getChildFile(fullFileName),
                            filter,
                            true
                        );

                        auto chooserFlags = juce::FileBrowserComponent::saveMode | juce::FileBrowserComponent::canSelectFiles;

                        fileChooser->launchAsync(chooserFlags, [completion, formatExt](const juce::FileChooser& fc) {
                            auto result = fc.getResult();
                            if (result.getFullPathName().isNotEmpty()) {
                                juce::String path = result.getFullPathName();
                                // Ensure correct extension
                                if (!path.endsWithIgnoreCase("." + formatExt)) {
                                    path += "." + formatExt;
                                }
                                completion(path);
                            } else {
                                completion("");  // User cancelled
                            }
                        });
                    })
                    .withNativeFunction ("renderProject", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        // Render/Export project to audio file
                        // Args: [source, startTime, endTime, filePath, format, sampleRate, bitDepth, channels, normalize, addTail, tailLength]
                        if (args.size() == 11) {
                            juce::String source = args[0].toString();
                            double startTime = (double)args[1];
                            double endTime = (double)args[2];
                            juce::String filePathArg = args[3].toString();
                            juce::String format = args[4].toString();
                            double sampleRate = (double)args[5];
                            int bitDepth = (int)args[6];
                            int channels = (int)args[7];
                            bool normalizeArg = (bool)args[8];
                            bool addTail = (bool)args[9];
                            double tailLength = (double)args[10];

                            // Run on background thread to avoid blocking message thread
                            std::thread([this, source, startTime, endTime, filePathArg, format,
                                         sampleRate, bitDepth, channels, normalizeArg, addTail, tailLength,
                                         completion = std::make_shared<juce::WebBrowserComponent::NativeFunctionCompletion>(std::move(completion))]() {
                                bool success = audioEngine.renderProject(
                                    source, startTime, endTime, filePathArg, format,
                                    sampleRate, bitDepth, channels, normalizeArg, addTail, tailLength);
                                // Call completion on the message thread to avoid crash
                                // (WebView callbacks must not be invoked from background threads)
                                juce::MessageManager::callAsync([completion, success]() {
                                    (*completion)(success);
                                });
                            }).detach();
                        } else {
                            juce::Logger::writeToLog("renderProject: Invalid args count: " + juce::String(args.size()));
                            completion(false);
                        }
                    })
                    .withNativeFunction ("renderProjectWithDither", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        // Args: [source, startTime, endTime, filePath, format, sampleRate, bitDepth, channels, normalize, addTail, tailLength, ditherType]
                        if (args.size() == 12) {
                            juce::String source = args[0].toString();
                            double startTime = (double)args[1];
                            double endTime = (double)args[2];
                            juce::String filePathArg = args[3].toString();
                            juce::String format = args[4].toString();
                            double sampleRate = (double)args[5];
                            int bitDepth = (int)args[6];
                            int channels = (int)args[7];
                            bool normalizeArg = (bool)args[8];
                            bool addTail = (bool)args[9];
                            double tailLength = (double)args[10];
                            juce::String ditherType = args[11].toString();

                            std::thread([this, source, startTime, endTime, filePathArg, format,
                                         sampleRate, bitDepth, channels, normalizeArg, addTail, tailLength, ditherType,
                                         completion = std::make_shared<juce::WebBrowserComponent::NativeFunctionCompletion>(std::move(completion))]() {
                                bool success = audioEngine.renderProjectWithDither(
                                    source, startTime, endTime, filePathArg, format,
                                    sampleRate, bitDepth, channels, normalizeArg, addTail, tailLength, ditherType);
                                juce::MessageManager::callAsync([completion, success]() {
                                    (*completion)(success);
                                });
                            }).detach();
                        } else {
                            completion(false);
                        }
                    })
                    // ===== Phase 9: Audio Engine Enhancements =====
                    .withNativeFunction ("reverseAudioFile", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        // Phase 9A: Reverse an audio file
                        // Args: [filePath] -> returns path to reversed file
                        if (args.size() == 1 && args[0].isString()) {
                            juce::String filePath = args[0].toString();
                            std::thread([this, filePath,
                                         completion = std::make_shared<juce::WebBrowserComponent::NativeFunctionCompletion>(std::move(completion))]() {
                                juce::String reversedPath = audioEngine.getAudioAnalyzer().reverseAudioFile(filePath);
                                juce::MessageManager::callAsync([completion, reversedPath]() {
                                    (*completion)(reversedPath);
                                });
                            }).detach();
                        } else {
                            completion(juce::String());
                        }
                    })
                    .withNativeFunction ("detectTransients", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        // Phase 9B: Detect transients in an audio file
                        // Args: [filePath, sensitivity, minGapMs] -> returns array of times (seconds)
                        if (args.size() == 3 && args[0].isString()) {
                            juce::String filePath = args[0].toString();
                            double sensitivity = (double)args[1];
                            double minGapMs = (double)args[2];
                            std::thread([this, filePath, sensitivity, minGapMs,
                                         completion = std::make_shared<juce::WebBrowserComponent::NativeFunctionCompletion>(std::move(completion))]() {
                                auto transients = audioEngine.getAudioAnalyzer().detectTransients(filePath, sensitivity, minGapMs);
                                juce::Array<juce::var> result;
                                for (double t : transients)
                                    result.add(t);
                                juce::MessageManager::callAsync([completion, result]() {
                                    (*completion)(juce::var(result));
                                });
                            }).detach();
                        } else {
                            completion(juce::var(juce::Array<juce::var>()));
                        }
                    })
                    .withNativeFunction ("setMetronomeClickSound", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        // Phase 9C: Set custom click sound for regular beats
                        // Args: [filePath] — empty string to reset to default
                        if (args.size() == 1 && args[0].isString()) {
                            juce::String filePath = args[0].toString();
                            bool success = audioEngine.setMetronomeClickSound(filePath);
                            completion(success);
                        } else {
                            completion(false);
                        }
                    })
                    .withNativeFunction ("setMetronomeAccentSound", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        // Phase 9C: Set custom accent sound for accented beats
                        // Args: [filePath] — empty string to reset to default
                        if (args.size() == 1 && args[0].isString()) {
                            juce::String filePath = args[0].toString();
                            bool success = audioEngine.setMetronomeAccentSound(filePath);
                            completion(success);
                        } else {
                            completion(false);
                        }
                    })
                    .withNativeFunction ("resetMetronomeSounds", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        // Phase 9C: Reset metronome to default synthesized sounds
                        juce::ignoreUnused(args);
                        audioEngine.resetMetronomeSounds();
                        completion(true);
                    })
                    // ===== Phase 11: Send/Bus Routing =====
                    .withNativeFunction ("addTrackSend", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        if (args.size() == 2) {
                            int idx = audioEngine.addTrackSend(args[0].toString(), args[1].toString());
                            completion(idx);
                        } else {
                            completion(-1);
                        }
                    })
                    .withNativeFunction ("removeTrackSend", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        if (args.size() == 2) {
                            audioEngine.removeTrackSend(args[0].toString(), (int)args[1]);
                            completion(true);
                        } else {
                            completion(false);
                        }
                    })
                    .withNativeFunction ("setTrackSendLevel", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        if (args.size() == 3) {
                            audioEngine.setTrackSendLevel(args[0].toString(), (int)args[1], (float)(double)args[2]);
                            completion(true);
                        } else {
                            completion(false);
                        }
                    })
                    .withNativeFunction ("setTrackSendPan", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        if (args.size() == 3) {
                            audioEngine.setTrackSendPan(args[0].toString(), (int)args[1], (float)(double)args[2]);
                            completion(true);
                        } else {
                            completion(false);
                        }
                    })
                    .withNativeFunction ("setTrackSendEnabled", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        if (args.size() == 3) {
                            audioEngine.setTrackSendEnabled(args[0].toString(), (int)args[1], (bool)args[2]);
                            completion(true);
                        } else {
                            completion(false);
                        }
                    })
                    .withNativeFunction ("setTrackSendPreFader", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        if (args.size() == 3) {
                            audioEngine.setTrackSendPreFader(args[0].toString(), (int)args[1], (bool)args[2]);
                            completion(true);
                        } else {
                            completion(false);
                        }
                    })
                    .withNativeFunction ("getTrackSends", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        if (args.size() == 1) {
                            completion(audioEngine.getTrackSends(args[0].toString()));
                        } else {
                            completion(juce::Array<juce::var>());
                        }
                    })
                    .withNativeFunction ("setTrackSendPhaseInvert", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        if (args.size() == 3) {
                            audioEngine.setTrackSendPhaseInvert(args[0].toString(), (int)args[1], (bool)args[2]);
                            completion(true);
                        } else { completion(false); }
                    })
                    .withNativeFunction ("setTrackPhaseInvert", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        if (args.size() == 2) {
                            audioEngine.setTrackPhaseInvert(args[0].toString(), (bool)args[1]);
                            completion(true);
                        } else { completion(false); }
                    })
                    .withNativeFunction ("getTrackPhaseInvert", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        if (args.size() == 1) {
                            completion(audioEngine.getTrackPhaseInvert(args[0].toString()));
                        } else { completion(false); }
                    })
                    .withNativeFunction ("setTrackStereoWidth", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        if (args.size() == 2) {
                            audioEngine.setTrackStereoWidth(args[0].toString(), (float)(double)args[1]);
                            completion(true);
                        } else { completion(false); }
                    })
                    .withNativeFunction ("getTrackStereoWidth", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        if (args.size() == 1) {
                            completion(audioEngine.getTrackStereoWidth(args[0].toString()));
                        } else { completion(100.0f); }
                    })
                    .withNativeFunction ("setTrackMasterSendEnabled", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        if (args.size() == 2) {
                            audioEngine.setTrackMasterSendEnabled(args[0].toString(), (bool)args[1]);
                            completion(true);
                        } else { completion(false); }
                    })
                    .withNativeFunction ("getTrackMasterSendEnabled", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        if (args.size() == 1) {
                            completion(audioEngine.getTrackMasterSendEnabled(args[0].toString()));
                        } else { completion(true); }
                    })
                    .withNativeFunction ("setTrackOutputChannels", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        if (args.size() == 3) {
                            audioEngine.setTrackOutputChannels(args[0].toString(), (int)args[1], (int)args[2]);
                            completion(true);
                        } else { completion(false); }
                    })
                    .withNativeFunction ("setTrackPlaybackOffset", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        if (args.size() == 2) {
                            audioEngine.setTrackPlaybackOffset(args[0].toString(), (double)args[1]);
                            completion(true);
                        } else { completion(false); }
                    })
                    .withNativeFunction ("getTrackPlaybackOffset", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        if (args.size() == 1) {
                            completion(audioEngine.getTrackPlaybackOffset(args[0].toString()));
                        } else { completion(0.0); }
                    })
                    .withNativeFunction ("setTrackChannelCount", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        if (args.size() == 2) {
                            audioEngine.setTrackChannelCount(args[0].toString(), (int)args[1]);
                            completion(true);
                        } else { completion(false); }
                    })
                    .withNativeFunction ("getTrackChannelCount", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        if (args.size() == 1) {
                            completion(audioEngine.getTrackChannelCount(args[0].toString()));
                        } else { completion(2); }
                    })
                    .withNativeFunction ("setTrackMIDIOutput", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        if (args.size() == 2) {
                            audioEngine.setTrackMIDIOutput(args[0].toString(), args[1].toString());
                            completion(true);
                        } else { completion(false); }
                    })
                    .withNativeFunction ("getTrackMIDIOutput", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        if (args.size() == 1) {
                            completion(audioEngine.getTrackMIDIOutput(args[0].toString()));
                        } else { completion(juce::String()); }
                    })
                    .withNativeFunction ("getTrackRoutingInfo", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        if (args.size() == 1) {
                            completion(audioEngine.getTrackRoutingInfo(args[0].toString()));
                        } else { completion(juce::var()); }
                    })
                    .withNativeFunction ("measureLUFS", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        // Phase 9D: Measure LUFS for an audio file
                        // Args: [filePath, startTime?, endTime?] -> returns {integrated, shortTerm, momentary, truePeak, range}
                        if (args.size() >= 1 && args[0].isString()) {
                            juce::String filePath = args[0].toString();
                            double startTime = args.size() > 1 ? (double)args[1] : 0.0;
                            double endTime = args.size() > 2 ? (double)args[2] : 0.0;
                            std::thread([this, filePath, startTime, endTime,
                                         completion = std::make_shared<juce::WebBrowserComponent::NativeFunctionCompletion>(std::move(completion))]() {
                                auto lufs = audioEngine.getAudioAnalyzer().measureLUFS(filePath, startTime, endTime);
                                auto* resultObj = new juce::DynamicObject();
                                resultObj->setProperty("integrated", lufs.integrated);
                                resultObj->setProperty("shortTerm", lufs.shortTerm);
                                resultObj->setProperty("momentary", lufs.momentary);
                                resultObj->setProperty("truePeak", lufs.truePeak);
                                resultObj->setProperty("range", lufs.range);
                                juce::var resultVar(resultObj);
                                juce::MessageManager::callAsync([completion, resultVar]() {
                                    (*completion)(resultVar);
                                });
                            }).detach();
                        } else {
                            completion(false);
                        }
                    })
                    // ===== Phase 12: Media & File Management =====
                    .withNativeFunction ("browseDirectory", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        // Args: [directoryPath]
                        // Returns: Array of {name, path, size, isDirectory, format, duration, sampleRate, numChannels}
                        if (args.size() >= 1 && args[0].isString()) {
                            juce::String dirPath = args[0].toString();
                            juce::File dir(dirPath);

                            if (!dir.isDirectory()) {
                                completion(juce::Array<juce::var>());
                                return;
                            }

                            auto files = dir.findChildFiles(juce::File::findFilesAndDirectories, false);
                            files.sort();

                            juce::Array<juce::var> result;
                            juce::AudioFormatManager formatMgr;
                            formatMgr.registerBasicFormats();

                            for (const auto& file : files) {
                                auto* obj = new juce::DynamicObject();
                                obj->setProperty("name", file.getFileName());
                                obj->setProperty("path", file.getFullPathName());
                                obj->setProperty("size", (juce::int64)file.getSize());
                                obj->setProperty("isDirectory", file.isDirectory());

                                if (!file.isDirectory()) {
                                    juce::String ext = file.getFileExtension().toLowerCase();
                                    obj->setProperty("format", ext.substring(1)); // Remove leading dot

                                    // Try to read audio metadata
                                    std::unique_ptr<juce::AudioFormatReader> reader(formatMgr.createReaderFor(file));
                                    if (reader) {
                                        double duration = reader->lengthInSamples / reader->sampleRate;
                                        obj->setProperty("duration", duration);
                                        obj->setProperty("sampleRate", (int)reader->sampleRate);
                                        obj->setProperty("numChannels", (int)reader->numChannels);
                                    } else {
                                        obj->setProperty("duration", 0.0);
                                        obj->setProperty("sampleRate", 0);
                                        obj->setProperty("numChannels", 0);
                                    }
                                } else {
                                    obj->setProperty("format", "");
                                    obj->setProperty("duration", 0.0);
                                    obj->setProperty("sampleRate", 0);
                                    obj->setProperty("numChannels", 0);
                                }

                                result.add(juce::var(obj));
                            }

                            completion(result);
                        } else {
                            completion(juce::Array<juce::var>());
                        }
                    })
                    .withNativeFunction ("previewAudioFile", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        // Preview an audio file through the output device (not through the track graph)
                        if (args.size() >= 1 && args[0].isString()) {
                            juce::String filePath = args[0].toString();
                            // For now, just log - full preview would require a separate AudioSource
                            juce::Logger::writeToLog("previewAudioFile: " + filePath);
                            completion(true);
                        } else {
                            completion(false);
                        }
                    })
                    .withNativeFunction ("stopPreview", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        juce::ignoreUnused(args);
                        juce::Logger::writeToLog("stopPreview called");
                        completion(true);
                    })
                    .withNativeFunction ("cleanProjectDirectory", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        // Args: [projectDir, referencedFilesArray]
                        // Returns: { orphanedFiles: Array<{path, size}>, totalSize }
                        if (args.size() >= 2 && args[0].isString() && args[1].isArray()) {
                            juce::String projectDir = args[0].toString();
                            auto* refArray = args[1].getArray();

                            // Build set of referenced file paths (normalized)
                            std::set<juce::String> referencedPaths;
                            if (refArray) {
                                for (const auto& ref : *refArray) {
                                    referencedPaths.insert(juce::File(ref.toString()).getFullPathName().toLowerCase());
                                }
                            }

                            juce::File dir(projectDir);
                            auto allFiles = dir.findChildFiles(juce::File::findFiles, true);

                            juce::Array<juce::var> orphanedFiles;
                            juce::int64 totalSize = 0;

                            for (const auto& file : allFiles) {
                                juce::String normalized = file.getFullPathName().toLowerCase();
                                // Skip project files (.s13proj, .json)
                                juce::String ext = file.getFileExtension().toLowerCase();
                                if (ext == ".s13proj" || ext == ".json" || ext == ".bak") continue;

                                if (referencedPaths.find(normalized) == referencedPaths.end()) {
                                    auto* obj = new juce::DynamicObject();
                                    obj->setProperty("path", file.getFullPathName());
                                    obj->setProperty("size", (juce::int64)file.getSize());
                                    orphanedFiles.add(juce::var(obj));
                                    totalSize += file.getSize();
                                }
                            }

                            auto* resultObj = new juce::DynamicObject();
                            resultObj->setProperty("orphanedFiles", orphanedFiles);
                            resultObj->setProperty("totalSize", totalSize);
                            completion(juce::var(resultObj));
                        } else {
                            auto* resultObj = new juce::DynamicObject();
                            resultObj->setProperty("orphanedFiles", juce::Array<juce::var>());
                            resultObj->setProperty("totalSize", 0);
                            completion(juce::var(resultObj));
                        }
                    })
                    .withNativeFunction ("deleteFiles", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        juce::ignoreUnused(this);
                        // Args: [filePathsArray]
                        // Returns: { deleted: number, errors: string[] }
                        if (args.size() >= 1 && args[0].isArray()) {
                            auto* pathArray = args[0].getArray();
                            int deletedCount = 0;
                            juce::Array<juce::var> errors;

                            if (pathArray) {
                                for (const auto& pathVar : *pathArray) {
                                    juce::File file(pathVar.toString());
                                    if (file.deleteFile()) {
                                        deletedCount++;
                                    } else {
                                        errors.add("Failed to delete: " + file.getFullPathName());
                                    }
                                }
                            }

                            auto* resultObj = new juce::DynamicObject();
                            resultObj->setProperty("deleted", deletedCount);
                            resultObj->setProperty("errors", errors);
                            completion(juce::var(resultObj));
                        } else {
                            auto* resultObj = new juce::DynamicObject();
                            resultObj->setProperty("deleted", 0);
                            resultObj->setProperty("errors", juce::Array<juce::var>());
                            completion(juce::var(resultObj));
                        }
                    })
                    .withNativeFunction ("exportProjectMIDI", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        juce::ignoreUnused(this);
                        // Args: [filePath, midiTracksJson]
                        // midiTracksJson is an array of { name, clips: [{ startTime, duration, events: [{ type, timestamp, note, velocity }] }] }
                        if (args.size() >= 2 && args[0].isString() && args[1].isArray()) {
                            juce::String filePath = args[0].toString();
                            auto* tracksArray = args[1].getArray();

                            juce::MidiFile midiFile;
                            midiFile.setTicksPerQuarterNote(480);

                            double bpm = 120.0; // Default BPM

                            if (tracksArray) {
                                for (const auto& trackVar : *tracksArray) {
                                    if (auto* trackObj = trackVar.getDynamicObject()) {
                                        juce::MidiMessageSequence sequence;

                                        auto* clips = trackObj->getProperty("clips").getArray();
                                        if (clips) {
                                            for (const auto& clipVar : *clips) {
                                                if (auto* clipObj = clipVar.getDynamicObject()) {
                                                    double clipStart = (double)clipObj->getProperty("startTime");
                                                    auto* events = clipObj->getProperty("events").getArray();
                                                    if (events) {
                                                        for (const auto& eventVar : *events) {
                                                            if (auto* eventObj = eventVar.getDynamicObject()) {
                                                                juce::String eventType = eventObj->getProperty("type").toString();
                                                                double timestamp = (double)eventObj->getProperty("timestamp");
                                                                double absoluteTime = clipStart + timestamp;
                                                                double ticks = absoluteTime * bpm / 60.0 * 480.0;

                                                                if (eventType == "noteOn") {
                                                                    int note = (int)eventObj->getProperty("note");
                                                                    int velocity = (int)eventObj->getProperty("velocity");
                                                                    sequence.addEvent(juce::MidiMessage::noteOn(1, note, (juce::uint8)velocity), ticks);
                                                                } else if (eventType == "noteOff") {
                                                                    int note = (int)eventObj->getProperty("note");
                                                                    sequence.addEvent(juce::MidiMessage::noteOff(1, note), ticks);
                                                                } else if (eventType == "cc") {
                                                                    int controller = (int)eventObj->getProperty("controller");
                                                                    int value = (int)eventObj->getProperty("value");
                                                                    sequence.addEvent(juce::MidiMessage::controllerEvent(1, controller, value), ticks);
                                                                }
                                                            }
                                                        }
                                                    }
                                                }
                                            }
                                        }

                                        sequence.updateMatchedPairs();
                                        midiFile.addTrack(sequence);
                                    }
                                }
                            }

                            juce::File outFile(filePath);
                            outFile.deleteFile();
                            std::unique_ptr<juce::FileOutputStream> stream(outFile.createOutputStream());
                            if (stream) {
                                bool success = midiFile.writeTo(*stream);
                                completion(success);
                            } else {
                                completion(false);
                            }
                        } else {
                            completion(false);
                        }
                    })
                    .withNativeFunction ("convertAudioFile", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        juce::ignoreUnused(this);
                        // Args: [inputPath, outputPath, format, sampleRate, bitDepth, channels]
                        if (args.size() >= 6 && args[0].isString() && args[1].isString()) {
                            juce::String inputPath = args[0].toString();
                            juce::String outputPath = args[1].toString();
                            juce::String format = args[2].toString();
                            int targetSampleRate = (int)args[3];
                            int targetBitDepth = (int)args[4];
                            int targetChannels = (int)args[5];

                            std::thread([inputPath, outputPath, format, targetSampleRate, targetBitDepth, targetChannels,
                                         completion = std::make_shared<juce::WebBrowserComponent::NativeFunctionCompletion>(std::move(completion))]() {
                                juce::AudioFormatManager formatMgr;
                                formatMgr.registerBasicFormats();

                                juce::File inFile(inputPath);
                                std::unique_ptr<juce::AudioFormatReader> reader(formatMgr.createReaderFor(inFile));

                                if (!reader) {
                                    juce::MessageManager::callAsync([completion]() { (*completion)(false); });
                                    return;
                                }

                                // Choose output format
                                juce::AudioFormat* outputFormat = nullptr;
                                if (format == "wav") outputFormat = formatMgr.findFormatForFileExtension("wav");
                                else if (format == "aiff") outputFormat = formatMgr.findFormatForFileExtension("aiff");
                                else if (format == "flac") outputFormat = formatMgr.findFormatForFileExtension("flac");
                                else outputFormat = formatMgr.findFormatForFileExtension("wav"); // Default to WAV

                                if (!outputFormat) {
                                    juce::MessageManager::callAsync([completion]() { (*completion)(false); });
                                    return;
                                }

                                juce::File outFile(outputPath);
                                outFile.deleteFile();
                                std::unique_ptr<juce::FileOutputStream> stream(outFile.createOutputStream());

                                if (!stream) {
                                    juce::MessageManager::callAsync([completion]() { (*completion)(false); });
                                    return;
                                }

                                int outChannels = targetChannels > 0 ? targetChannels : (int)reader->numChannels;
                                int outSampleRate = targetSampleRate > 0 ? targetSampleRate : (int)reader->sampleRate;
                                int outBitDepth = targetBitDepth > 0 ? targetBitDepth : (int)reader->bitsPerSample;

                                std::unique_ptr<juce::AudioFormatWriter> writer(outputFormat->createWriterFor(
                                    stream.get(), outSampleRate, (unsigned int)outChannels, outBitDepth, {}, 0));

                                if (!writer) {
                                    juce::MessageManager::callAsync([completion]() { (*completion)(false); });
                                    return;
                                }

                                stream.release(); // Writer takes ownership

                                // Read and write in blocks
                                const int blockSize = 8192;
                                juce::AudioBuffer<float> buffer(outChannels, blockSize);
                                juce::int64 totalSamples = reader->lengthInSamples;
                                juce::int64 written = 0;

                                while (written < totalSamples) {
                                    int samplesToRead = (int)std::min((juce::int64)blockSize, totalSamples - written);
                                    buffer.clear();
                                    reader->read(&buffer, 0, samplesToRead, written, true, true);
                                    writer->writeFromAudioSampleBuffer(buffer, 0, samplesToRead);
                                    written += samplesToRead;
                                }

                                writer.reset();

                                juce::MessageManager::callAsync([completion]() { (*completion)(true); });
                            }).detach();
                        } else {
                            completion(false);
                        }
                    })
                    .withNativeFunction ("getHomeDirectory", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        juce::ignoreUnused(args);
                        completion(juce::File::getSpecialLocation(juce::File::userHomeDirectory).getFullPathName());
                    })
                    // ===== Phase 13: Advanced Editing =====
                    .withNativeFunction ("timeStretchClip", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        juce::ignoreUnused(this);
                        // Args: [filePath, factor] -> returns JSON {success, filePath, duration, sampleRate}
                        // factor: atempo value — 2.0 = double speed (half duration), 0.5 = half speed (double duration)
                        if (args.size() >= 2 && args[0].isString()) {
                            juce::String filePath = args[0].toString();
                            double factor = (double)args[1];

                            if (factor <= 0.0 || std::abs(factor - 1.0) < 0.0001) {
                                completion(juce::String()); // No change needed
                                return;
                            }

                            juce::File inputFile(filePath);
                            juce::String timestamp = juce::String(juce::Time::currentTimeMillis());
                            juce::File outputFile = inputFile.getSiblingFile(
                                inputFile.getFileNameWithoutExtension() + "_ts_" + timestamp + inputFile.getFileExtension()
                            );

                            // Find FFmpeg
                            auto exeDir = juce::File::getSpecialLocation(juce::File::currentExecutableFile).getParentDirectory();
                            juce::File ffmpeg = exeDir.getChildFile("ffmpeg.exe");
                            if (!ffmpeg.existsAsFile()) ffmpeg = exeDir.getChildFile("tools").getChildFile("ffmpeg.exe");
                            if (!ffmpeg.existsAsFile()) ffmpeg = exeDir.getParentDirectory().getChildFile("tools").getChildFile("ffmpeg.exe");
                            if (!ffmpeg.existsAsFile()) {
                                completion(juce::String());
                                return;
                            }
                            juce::String ffmpegPath = ffmpeg.getFullPathName();

                            std::thread([filePath, outputFile, factor, ffmpegPath,
                                         completion = std::make_shared<juce::WebBrowserComponent::NativeFunctionCompletion>(std::move(completion))]() {
                                // Build atempo filter chain — atempo supports [0.5, 100.0]
                                juce::String atempoFilter;
                                double remaining = factor;
                                if (remaining < 0.5) {
                                    while (remaining < 0.5) {
                                        atempoFilter += (atempoFilter.isEmpty() ? "" : ",") + juce::String("atempo=0.5");
                                        remaining /= 0.5;
                                    }
                                    if (std::abs(remaining - 1.0) > 0.0001)
                                        atempoFilter += ",atempo=" + juce::String(remaining);
                                } else if (remaining > 100.0) {
                                    while (remaining > 100.0) {
                                        atempoFilter += (atempoFilter.isEmpty() ? "" : ",") + juce::String("atempo=100.0");
                                        remaining /= 100.0;
                                    }
                                    if (std::abs(remaining - 1.0) > 0.0001)
                                        atempoFilter += ",atempo=" + juce::String(remaining);
                                } else {
                                    atempoFilter = "atempo=" + juce::String(factor);
                                }

                                juce::StringArray processArgs;
                                processArgs.add(ffmpegPath);
                                processArgs.add("-y");
                                processArgs.add("-i");
                                processArgs.add(filePath);
                                processArgs.add("-af");
                                processArgs.add(atempoFilter);
                                processArgs.add(outputFile.getFullPathName());

                                juce::ChildProcess process;
                                bool started = process.start(processArgs);
                                bool finished = started && process.waitForProcessToFinish(120000);
                                int exitCode = finished ? process.getExitCode() : -1;

                                juce::DynamicObject::Ptr result = new juce::DynamicObject();
                                if (exitCode == 0 && outputFile.existsAsFile()) {
                                    result->setProperty("success", true);
                                    result->setProperty("filePath", outputFile.getFullPathName());
                                    // Read output file to get duration and sample rate
                                    juce::AudioFormatManager fmgr;
                                    fmgr.registerBasicFormats();
                                    std::unique_ptr<juce::AudioFormatReader> reader(fmgr.createReaderFor(outputFile));
                                    if (reader) {
                                        result->setProperty("duration", (double)reader->lengthInSamples / reader->sampleRate);
                                        result->setProperty("sampleRate", reader->sampleRate);
                                    }
                                } else {
                                    result->setProperty("success", false);
                                }

                                juce::MessageManager::callAsync([completion, result]() {
                                    (*completion)(juce::var(result.get()));
                                });
                            }).detach();
                        } else {
                            completion(juce::String());
                        }
                    })
                    .withNativeFunction ("pitchShiftClip", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        juce::ignoreUnused(this);
                        // Args: [filePath, semitones] -> returns JSON {success, filePath, duration, sampleRate}
                        // Uses asetrate to change pitch, aresample to fix SR, atempo to compensate duration
                        if (args.size() >= 2 && args[0].isString()) {
                            juce::String filePath = args[0].toString();
                            double semitones = (double)args[1];

                            if (std::abs(semitones) < 0.01) {
                                completion(juce::String()); // No change needed
                                return;
                            }

                            juce::File inputFile(filePath);
                            juce::String timestamp = juce::String(juce::Time::currentTimeMillis());
                            juce::File outputFile = inputFile.getSiblingFile(
                                inputFile.getFileNameWithoutExtension() + "_ps_" + timestamp + inputFile.getFileExtension()
                            );

                            // Detect file's actual sample rate
                            double fileSampleRate = 44100.0;
                            {
                                juce::AudioFormatManager fmgr;
                                fmgr.registerBasicFormats();
                                std::unique_ptr<juce::AudioFormatReader> reader(fmgr.createReaderFor(inputFile));
                                if (reader)
                                    fileSampleRate = reader->sampleRate;
                            }

                            // Convert semitones to frequency ratio: ratio = 2^(semitones/12)
                            double ratio = std::pow(2.0, semitones / 12.0);

                            // Find FFmpeg
                            auto exeDir = juce::File::getSpecialLocation(juce::File::currentExecutableFile).getParentDirectory();
                            juce::File ffmpeg = exeDir.getChildFile("ffmpeg.exe");
                            if (!ffmpeg.existsAsFile()) ffmpeg = exeDir.getChildFile("tools").getChildFile("ffmpeg.exe");
                            if (!ffmpeg.existsAsFile()) ffmpeg = exeDir.getParentDirectory().getChildFile("tools").getChildFile("ffmpeg.exe");
                            if (!ffmpeg.existsAsFile()) {
                                completion(juce::String());
                                return;
                            }
                            juce::String ffmpegPath = ffmpeg.getFullPathName();
                            int srInt = (int)fileSampleRate;

                            std::thread([filePath, outputFile, ratio, ffmpegPath, srInt,
                                         completion = std::make_shared<juce::WebBrowserComponent::NativeFunctionCompletion>(std::move(completion))]() {
                                // asetrate changes pitch+speed, aresample restores SR, atempo compensates speed
                                // Tempo compensation: 1/ratio — need to chain if outside [0.5, 100.0]
                                double tempoComp = 1.0 / ratio;
                                juce::String atempoChain;
                                double remaining = tempoComp;
                                if (remaining < 0.5) {
                                    while (remaining < 0.5) {
                                        atempoChain += ",atempo=0.5";
                                        remaining /= 0.5;
                                    }
                                    if (std::abs(remaining - 1.0) > 0.0001)
                                        atempoChain += ",atempo=" + juce::String(remaining);
                                } else if (remaining > 100.0) {
                                    while (remaining > 100.0) {
                                        atempoChain += ",atempo=100.0";
                                        remaining /= 100.0;
                                    }
                                    if (std::abs(remaining - 1.0) > 0.0001)
                                        atempoChain += ",atempo=" + juce::String(remaining);
                                } else {
                                    atempoChain = ",atempo=" + juce::String(tempoComp);
                                }

                                // Full filter: asetrate=SR*ratio,aresample=SR,atempo=1/ratio
                                juce::String filter = "asetrate=" + juce::String(srInt) + "*" + juce::String(ratio)
                                                    + ",aresample=" + juce::String(srInt)
                                                    + atempoChain;

                                juce::StringArray processArgs;
                                processArgs.add(ffmpegPath);
                                processArgs.add("-y");
                                processArgs.add("-i");
                                processArgs.add(filePath);
                                processArgs.add("-af");
                                processArgs.add(filter);
                                processArgs.add(outputFile.getFullPathName());

                                juce::ChildProcess process;
                                bool started = process.start(processArgs);
                                bool finished = started && process.waitForProcessToFinish(120000);
                                int exitCode = finished ? process.getExitCode() : -1;

                                juce::DynamicObject::Ptr result = new juce::DynamicObject();
                                if (exitCode == 0 && outputFile.existsAsFile()) {
                                    result->setProperty("success", true);
                                    result->setProperty("filePath", outputFile.getFullPathName());
                                    juce::AudioFormatManager fmgr;
                                    fmgr.registerBasicFormats();
                                    std::unique_ptr<juce::AudioFormatReader> reader(fmgr.createReaderFor(outputFile));
                                    if (reader) {
                                        result->setProperty("duration", (double)reader->lengthInSamples / reader->sampleRate);
                                        result->setProperty("sampleRate", reader->sampleRate);
                                    }
                                } else {
                                    result->setProperty("success", false);
                                }

                                juce::MessageManager::callAsync([completion, result]() {
                                    (*completion)(juce::var(result.get()));
                                });
                            }).detach();
                        } else {
                            completion(juce::String());
                        }
                    })
                    // ========== Phase 3.10: Control Surface Support ==========
                    .withNativeFunction ("connectMIDIControlSurface", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        // Args: [midiInputName, midiOutputName]
                        juce::String inputName = args.size() > 0 ? args[0].toString() : "";
                        juce::String outputName = args.size() > 1 ? args[1].toString() : "";
                        bool ok = audioEngine.getControlSurfaceManager().getMIDIControl().connect(inputName, outputName);
                        completion(ok);
                    })
                    .withNativeFunction ("disconnectMIDIControlSurface", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        juce::ignoreUnused(args);
                        audioEngine.getControlSurfaceManager().getMIDIControl().disconnect();
                        completion(true);
                    })
                    .withNativeFunction ("startMIDILearn", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        // Args: [trackId, parameter]
                        if (args.size() >= 2) {
                            audioEngine.getControlSurfaceManager().getMIDIControl().startLearn(
                                args[0].toString(), args[1].toString());
                        }
                        completion(true);
                    })
                    .withNativeFunction ("cancelMIDILearn", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        juce::ignoreUnused(args);
                        audioEngine.getControlSurfaceManager().getMIDIControl().cancelLearn();
                        completion(true);
                    })
                    .withNativeFunction ("getMIDIMappings", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        juce::ignoreUnused(args);
                        auto mappings = audioEngine.getControlSurfaceManager().getMIDIControl().getMappings();
                        juce::Array<juce::var> arr;
                        for (const auto& m : mappings) {
                            juce::DynamicObject::Ptr obj = new juce::DynamicObject();
                            obj->setProperty("channel", m.channel);
                            obj->setProperty("cc", m.cc);
                            obj->setProperty("trackId", m.trackId);
                            obj->setProperty("parameter", m.parameter);
                            arr.add(juce::var(obj.get()));
                        }
                        completion(juce::var(arr));
                    })
                    .withNativeFunction ("addMIDIMapping", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        // Args: [channel, cc, trackId, parameter]
                        if (args.size() >= 4) {
                            MIDICCMapping m;
                            m.channel = (int)args[0];
                            m.cc = (int)args[1];
                            m.trackId = args[2].toString();
                            m.parameter = args[3].toString();
                            audioEngine.getControlSurfaceManager().getMIDIControl().addMapping(m);
                        }
                        completion(true);
                    })
                    .withNativeFunction ("removeMIDIMapping", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        // Args: [channel, cc]
                        if (args.size() >= 2) {
                            audioEngine.getControlSurfaceManager().getMIDIControl().removeMapping(
                                (int)args[0], (int)args[1]);
                        }
                        completion(true);
                    })
                    .withNativeFunction ("connectOSC", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        // Args: [receivePort, sendHost, sendPort]
                        int recvPort = args.size() > 0 ? (int)args[0] : 8000;
                        juce::String sendHost = args.size() > 1 ? args[1].toString() : "127.0.0.1";
                        int sendPort = args.size() > 2 ? (int)args[2] : 9000;
                        bool ok = audioEngine.getControlSurfaceManager().getOSCControl().connect(recvPort, sendHost, sendPort);
                        completion(ok);
                    })
                    .withNativeFunction ("disconnectOSC", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        juce::ignoreUnused(args);
                        audioEngine.getControlSurfaceManager().getOSCControl().disconnect();
                        completion(true);
                    })
                    .withNativeFunction ("getControlSurfaceMIDIDevices", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        juce::ignoreUnused(args);
                        juce::DynamicObject::Ptr result = new juce::DynamicObject();
                        auto inputs = ControlSurfaceManager::getAvailableMIDIInputs();
                        auto outputs = ControlSurfaceManager::getAvailableMIDIOutputs();
                        juce::Array<juce::var> inputArr, outputArr;
                        for (const auto& n : inputs) inputArr.add(n);
                        for (const auto& n : outputs) outputArr.add(n);
                        result->setProperty("inputs", inputArr);
                        result->setProperty("outputs", outputArr);
                        completion(juce::var(result.get()));
                    })
                    // ========== Phase 3.9: Timecode / Sync ==========
                    .withNativeFunction ("connectMIDIClockOutput", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        if (args.size() >= 1 && args[0].isString()) {
                            bool ok = audioEngine.getTimecodeSyncManager().getClockOutput().connect(args[0].toString());
                            completion(ok);
                        } else { completion(false); }
                    })
                    .withNativeFunction ("setMIDIClockOutputEnabled", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        if (args.size() >= 1)
                            audioEngine.getTimecodeSyncManager().getClockOutput().setEnabled((bool)args[0]);
                        completion(true);
                    })
                    .withNativeFunction ("connectMIDIClockInput", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        if (args.size() >= 1 && args[0].isString()) {
                            bool ok = audioEngine.getTimecodeSyncManager().getClockInput().connect(args[0].toString());
                            completion(ok);
                        } else { completion(false); }
                    })
                    .withNativeFunction ("setMIDIClockInputEnabled", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        if (args.size() >= 1)
                            audioEngine.getTimecodeSyncManager().getClockInput().setEnabled((bool)args[0]);
                        completion(true);
                    })
                    .withNativeFunction ("connectMTCOutput", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        if (args.size() >= 1 && args[0].isString()) {
                            bool ok = audioEngine.getTimecodeSyncManager().getMTCGenerator().connect(args[0].toString());
                            completion(ok);
                        } else { completion(false); }
                    })
                    .withNativeFunction ("setMTCEnabled", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        if (args.size() >= 1)
                            audioEngine.getTimecodeSyncManager().getMTCGenerator().setEnabled((bool)args[0]);
                        completion(true);
                    })
                    .withNativeFunction ("setMTCFrameRate", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        if (args.size() >= 1) {
                            int rate = (int)args[0];
                            audioEngine.getTimecodeSyncManager().getMTCGenerator().setFrameRate(static_cast<SMPTEFrameRate>(rate));
                        }
                        completion(true);
                    })
                    .withNativeFunction ("connectMTCInput", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        if (args.size() >= 1 && args[0].isString()) {
                            bool ok = audioEngine.getTimecodeSyncManager().getMTCReceiver().connect(args[0].toString());
                            completion(ok);
                        } else { completion(false); }
                    })
                    .withNativeFunction ("setSyncSource", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        if (args.size() >= 1 && args[0].isString()) {
                            juce::String src = args[0].toString();
                            if (src == "midi_clock")
                                audioEngine.getTimecodeSyncManager().setSyncSource(TimecodeSyncManager::SyncSource::MIDIClock);
                            else if (src == "mtc")
                                audioEngine.getTimecodeSyncManager().setSyncSource(TimecodeSyncManager::SyncSource::MTC);
                            else
                                audioEngine.getTimecodeSyncManager().setSyncSource(TimecodeSyncManager::SyncSource::Internal);
                        }
                        completion(true);
                    })
                    .withNativeFunction ("getSyncStatus", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        juce::ignoreUnused(args);
                        auto* result = new juce::DynamicObject();
                        auto& tsm = audioEngine.getTimecodeSyncManager();
                        result->setProperty("locked", tsm.isSyncLocked());
                        result->setProperty("source", tsm.getSyncSource() == TimecodeSyncManager::SyncSource::Internal ? "internal"
                            : tsm.getSyncSource() == TimecodeSyncManager::SyncSource::MIDIClock ? "midi_clock" : "mtc");
                        result->setProperty("externalBPM", tsm.getClockInput().getExternalBPM());
                        result->setProperty("mtcPosition", tsm.getMTCReceiver().getCurrentPosition());
                        completion(juce::var(result));
                    })
                    // ========== Phase 3.10.2: MCU (Mackie Control Universal) ==========
                    .withNativeFunction ("connectMCU", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        if (args.size() >= 2 && args[0].isString() && args[1].isString()) {
                            bool ok = audioEngine.getControlSurfaceManager().getMCUControl().connect(
                                args[0].toString(), args[1].toString());
                            completion(ok);
                        } else {
                            completion(false);
                        }
                    })
                    .withNativeFunction ("disconnectMCU", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        juce::ignoreUnused(args);
                        audioEngine.getControlSurfaceManager().getMCUControl().disconnect();
                        completion(true);
                    })
                    .withNativeFunction ("setMCUBankOffset", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        if (args.size() >= 1) {
                            int offset = (int)args[0];
                            audioEngine.getControlSurfaceManager().getMCUControl().setBankOffset(offset);
                        }
                        completion(true);
                    })
                    // ========== Phase 3.12: Strip Silence ==========
                    .withNativeFunction ("detectSilentRegions", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        // Args: [filePath, thresholdDb, minSilenceMs, minSoundMs, preAttackMs, postReleaseMs]
                        // Returns: array of { startTime, endTime, startSample, endSample }
                        if (args.size() >= 6 && args[0].isString()) {
                            juce::String filePath = args[0].toString();
                            double thresholdDb = (double)args[1];
                            double minSilenceMs = (double)args[2];
                            double minSoundMs = (double)args[3];
                            double preAttackMs = (double)args[4];
                            double postReleaseMs = (double)args[5];
                            std::thread([this, filePath, thresholdDb, minSilenceMs, minSoundMs, preAttackMs, postReleaseMs,
                                         completion = std::make_shared<juce::WebBrowserComponent::NativeFunctionCompletion>(std::move(completion))]() {
                                auto result = audioEngine.detectSilentRegions(filePath, thresholdDb, minSilenceMs, minSoundMs, preAttackMs, postReleaseMs);
                                juce::MessageManager::callAsync([completion, result]() {
                                    (*completion)(result);
                                });
                            }).detach();
                        } else {
                            completion(juce::Array<juce::var>());
                        }
                    })
                    // ========== Phase 3.13: Freeze Track ==========
                    .withNativeFunction ("freezeTrack", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        // Args: [trackId] -> returns { success, filePath, duration, sampleRate, startTime }
                        if (args.size() >= 1 && args[0].isString()) {
                            juce::String trackId = args[0].toString();
                            std::thread([this, trackId,
                                         completion = std::make_shared<juce::WebBrowserComponent::NativeFunctionCompletion>(std::move(completion))]() {
                                auto result = audioEngine.freezeTrack(trackId);
                                juce::MessageManager::callAsync([completion, result]() {
                                    (*completion)(result);
                                });
                            }).detach();
                        } else {
                            completion(juce::var());
                        }
                    })
                    .withNativeFunction ("unfreezeTrack", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        // Args: [trackId] -> returns bool
                        if (args.size() >= 1 && args[0].isString()) {
                            juce::String trackId = args[0].toString();
                            bool ok = audioEngine.unfreezeTrack(trackId);
                            completion(ok);
                        } else {
                            completion(false);
                        }
                    })
                    // ========== Phase 4.3: Built-in Effects ==========
                    .withNativeFunction ("addTrackBuiltInFX", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        // Args: [trackId, effectName, isInputFX?]
                        if (args.size() >= 2 && args[0].isString() && args[1].isString()) {
                            bool isInputFX = args.size() >= 3 && (bool)args[2];
                            bool ok = audioEngine.addTrackBuiltInFX(args[0].toString(), args[1].toString(), isInputFX);
                            completion(juce::var(ok));
                        } else {
                            completion(juce::var(false));
                        }
                    })
                    .withNativeFunction ("addMasterBuiltInFX", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        // Args: [effectName]
                        if (args.size() >= 1 && args[0].isString()) {
                            bool ok = audioEngine.addMasterBuiltInFX(args[0].toString());
                            completion(juce::var(ok));
                        } else {
                            completion(juce::var(false));
                        }
                    })
                    .withNativeFunction ("getAvailableBuiltInFX", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        juce::ignoreUnused(args);
                        completion(audioEngine.getAvailableBuiltInFX());
                    })
                    // ========== Phase 3.14: Session Interchange (AAF/RPP/EDL) ==========
                    .withNativeFunction ("importSession", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        // Args: [filePath] -> returns session data as JSON or error
                        if (args.size() >= 1 && args[0].isString()) {
                            juce::String filePath = args[0].toString();
                            juce::File file(filePath);
                            auto& si = audioEngine.getSessionInterchange();

                            SessionData data;
                            if (file.getFileExtension().equalsIgnoreCase(".rpp"))
                                data = si.importRPP(file);
                            else if (file.getFileExtension().equalsIgnoreCase(".aaf"))
                                data = si.importAAF(file);
                            else
                                data.error = "Unsupported format: " + file.getFileExtension();

                            juce::DynamicObject::Ptr result = new juce::DynamicObject();
                            if (data.error.isEmpty()) {
                                result->setProperty("success", true);
                                result->setProperty("tempo", data.tempo);
                                result->setProperty("sampleRate", data.sampleRate);
                                juce::Array<juce::var> tracksArr;
                                for (auto& t : data.tracks) {
                                    juce::DynamicObject::Ptr tObj = new juce::DynamicObject();
                                    tObj->setProperty("name", t.name);
                                    tObj->setProperty("volumeDB", (double)t.volumeDB);
                                    tObj->setProperty("pan", (double)t.pan);
                                    tObj->setProperty("muted", t.muted);
                                    tObj->setProperty("soloed", t.soloed);
                                    juce::Array<juce::var> clipsArr;
                                    for (auto& c : t.clips) {
                                        juce::DynamicObject::Ptr cObj = new juce::DynamicObject();
                                        cObj->setProperty("filePath", c.filePath);
                                        cObj->setProperty("position", c.position);
                                        cObj->setProperty("length", c.length);
                                        cObj->setProperty("offset", c.offset);
                                        cObj->setProperty("volumeDB", (double)c.volumeDB);
                                        clipsArr.add(juce::var(cObj.get()));
                                    }
                                    tObj->setProperty("clips", clipsArr);
                                    tracksArr.add(juce::var(tObj.get()));
                                }
                                result->setProperty("tracks", tracksArr);
                            } else {
                                result->setProperty("success", false);
                                result->setProperty("error", data.error);
                            }
                            completion(juce::var(result.get()));
                        } else {
                            completion(juce::var());
                        }
                    })
                    .withNativeFunction ("exportSession", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        // Args: [filePath, format, sessionJSON]
                        // format: "rpp" or "edl"
                        if (args.size() >= 3 && args[0].isString() && args[1].isString() && args[2].isObject()) {
                            juce::String filePath = args[0].toString();
                            juce::String format = args[1].toString();
                            auto* sessionObj = args[2].getDynamicObject();

                            SessionData data;
                            if (sessionObj) {
                                data.tempo = (double)sessionObj->getProperty("tempo");
                                data.sampleRate = (double)sessionObj->getProperty("sampleRate");
                                if (auto* tracksArr = sessionObj->getProperty("tracks").getArray()) {
                                    for (auto& tVar : *tracksArr) {
                                        if (auto* tObj = tVar.getDynamicObject()) {
                                            SessionTrack track;
                                            track.name = tObj->getProperty("name").toString();
                                            track.volumeDB = (float)(double)tObj->getProperty("volumeDB");
                                            track.pan = (float)(double)tObj->getProperty("pan");
                                            track.muted = (bool)tObj->getProperty("muted");
                                            track.soloed = (bool)tObj->getProperty("soloed");
                                            if (auto* clipsArr = tObj->getProperty("clips").getArray()) {
                                                for (auto& cVar : *clipsArr) {
                                                    if (auto* cObj = cVar.getDynamicObject()) {
                                                        SessionClip clip;
                                                        clip.filePath = cObj->getProperty("filePath").toString();
                                                        clip.position = (double)cObj->getProperty("position");
                                                        clip.length = (double)cObj->getProperty("length");
                                                        clip.offset = (double)cObj->getProperty("offset");
                                                        clip.volumeDB = (float)(double)cObj->getProperty("volumeDB");
                                                        track.clips.push_back(clip);
                                                    }
                                                }
                                            }
                                            data.tracks.push_back(track);
                                        }
                                    }
                                }
                            }

                            auto& si = audioEngine.getSessionInterchange();
                            bool ok = false;
                            if (format == "rpp")
                                ok = si.exportRPP(juce::File(filePath), data);
                            else if (format == "edl")
                                ok = si.exportEDL(juce::File(filePath), data);

                            completion(juce::var(ok));
                        } else {
                            completion(juce::var(false));
                        }
                    })
                    // ========== Phase 4.1: Clip Launch / Trigger ==========
                    .withNativeFunction ("triggerSlot", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        if (args.size() >= 2) {
                            audioEngine.getTriggerEngine().triggerSlot((int)args[0], (int)args[1]);
                            completion(juce::var(true));
                        } else {
                            completion(juce::var(false));
                        }
                    })
                    .withNativeFunction ("stopSlot", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        if (args.size() >= 2) {
                            audioEngine.getTriggerEngine().stopSlot((int)args[0], (int)args[1]);
                            completion(juce::var(true));
                        } else {
                            completion(juce::var(false));
                        }
                    })
                    .withNativeFunction ("triggerScene", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        if (args.size() >= 1) {
                            audioEngine.getTriggerEngine().triggerScene((int)args[0]);
                            completion(juce::var(true));
                        } else {
                            completion(juce::var(false));
                        }
                    })
                    .withNativeFunction ("stopAllSlots", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        juce::ignoreUnused(args);
                        audioEngine.getTriggerEngine().stopAll();
                        completion(juce::var(true));
                    })
                    .withNativeFunction ("setSlotClip", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        // Args: [trackIndex, slotIndex, filePath, duration]
                        if (args.size() >= 4 && args[2].isString()) {
                            audioEngine.getTriggerEngine().setSlotClip((int)args[0], (int)args[1],
                                args[2].toString(), (double)args[3]);
                            completion(juce::var(true));
                        } else {
                            completion(juce::var(false));
                        }
                    })
                    .withNativeFunction ("clearSlot", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        if (args.size() >= 2) {
                            audioEngine.getTriggerEngine().clearSlot((int)args[0], (int)args[1]);
                            completion(juce::var(true));
                        } else {
                            completion(juce::var(false));
                        }
                    })
                    .withNativeFunction ("getClipLauncherState", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        juce::ignoreUnused(args);
                        completion(audioEngine.getTriggerEngine().getGridState());
                    })
                    // ========== Phase 4.4: Sidechain Routing ==========
                    .withNativeFunction ("setSidechainSource", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        // Args: [destTrackId, pluginIndex, sourceTrackId]
                        if (args.size() >= 3 && args[0].isString() && args[2].isString()) {
                            audioEngine.setSidechainSource(args[0].toString(), (int)args[1], args[2].toString());
                            completion(juce::var(true));
                        } else {
                            completion(juce::var(false));
                        }
                    })
                    .withNativeFunction ("clearSidechainSource", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        // Args: [destTrackId, pluginIndex]
                        if (args.size() >= 2 && args[0].isString()) {
                            audioEngine.clearSidechainSource(args[0].toString(), (int)args[1]);
                            completion(juce::var(true));
                        } else {
                            completion(juce::var(false));
                        }
                    })
                    .withNativeFunction ("getSidechainSource", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        // Args: [destTrackId, pluginIndex] -> returns sourceTrackId
                        if (args.size() >= 2 && args[0].isString()) {
                            juce::String src = audioEngine.getSidechainSource(args[0].toString(), (int)args[1]);
                            completion(juce::var(src));
                        } else {
                            completion(juce::var(""));
                        }
                    })
                    // ========== Phase 3.7: Surround / Spatial Audio ==========
                    .withNativeFunction ("getSurroundLayouts", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        juce::ignoreUnused(args);
                        juce::Array<juce::var> layouts;
                        auto addLayout = [&](const juce::String& name, int channels) {
                            juce::DynamicObject::Ptr obj = new juce::DynamicObject();
                            obj->setProperty("name", name);
                            obj->setProperty("channels", channels);
                            layouts.add(juce::var(obj.get()));
                        };
                        addLayout("Stereo", 2);
                        addLayout("Quad", 4);
                        addLayout("5.1 Surround", 6);
                        addLayout("7.1 Surround", 8);
                        addLayout("7.1.4 Atmos", 12);
                        completion(juce::var(layouts));
                    })
                    // ========== Phase 15: Video, Scripting, LTC ==========
                    .withNativeFunction ("openVideoFile", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        // Args: [filePath] -> returns JSON with width, height, duration, fps, audioPath
                        if (args.size() >= 1 && args[0].isString()) {
                            juce::String filePath = args[0].toString();
                            juce::File audioDir = juce::File(filePath).getParentDirectory();

                            auto& vr = audioEngine.getVideoReader();
                            bool ok = vr.openFile(filePath, audioDir);

                            juce::DynamicObject::Ptr result = new juce::DynamicObject();
                            if (ok) {
                                auto& info = vr.getInfo();
                                result->setProperty("width", info.width);
                                result->setProperty("height", info.height);
                                result->setProperty("duration", info.duration);
                                result->setProperty("fps", info.fps);
                                result->setProperty("filePath", info.filePath);
                                result->setProperty("audioPath", info.audioPath);
                            } else {
                                result->setProperty("error", "Failed to open video file");
                            }
                            completion(juce::var(result.get()));
                        } else {
                            completion(juce::var());
                        }
                    })
                    .withNativeFunction ("getVideoFrame", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        // Args: [time, width?, height?] -> returns base64-encoded JPEG frame
                        if (args.size() >= 1) {
                            double timePos = (double)args[0];
                            int w = args.size() >= 2 ? (int)args[1] : 320;
                            int h = args.size() >= 3 ? (int)args[2] : 180;
                            juce::String frame = audioEngine.getVideoReader().getFrameAtTime(timePos, w, h);
                            completion(juce::var(frame));
                        } else {
                            completion(juce::String(""));
                        }
                    })
                    .withNativeFunction ("closeVideoFile", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        juce::ignoreUnused(args);
                        audioEngine.getVideoReader().closeFile();
                        completion(juce::var(true));
                    })
                    .withNativeFunction ("executeScript", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        juce::ignoreUnused(this);
                        // Args: [code] -> returns JSON { result, error }
                        // Stub implementation — scripting engine not yet integrated
                        if (args.size() >= 1 && args[0].isString()) {
                            juce::String code = args[0].toString();
                            juce::Logger::writeToLog("executeScript (stub): " + code.substring(0, 100));

                            juce::DynamicObject::Ptr result = new juce::DynamicObject();
                            result->setProperty("result", juce::String("Not implemented"));
                            result->setProperty("error", juce::String(""));

                            completion(juce::var(result.get()));
                        } else {
                            juce::DynamicObject::Ptr result = new juce::DynamicObject();
                            result->setProperty("result", juce::String(""));
                            result->setProperty("error", juce::String("No code provided"));

                            completion(juce::var(result.get()));
                        }
                    })
                    .withNativeFunction ("loadScriptFile", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        juce::ignoreUnused(this);
                        // Args: [filePath] -> loads and executes a script file
                        // Stub implementation — scripting engine not yet integrated
                        if (args.size() >= 1 && args[0].isString()) {
                            juce::String scriptPath = args[0].toString();
                            juce::Logger::writeToLog("loadScriptFile (stub): " + scriptPath);

                            juce::DynamicObject::Ptr result = new juce::DynamicObject();
                            result->setProperty("result", juce::String("Not implemented"));
                            result->setProperty("error", juce::String(""));

                            completion(juce::var(result.get()));
                        } else {
                            juce::DynamicObject::Ptr result = new juce::DynamicObject();
                            result->setProperty("result", juce::String(""));
                            result->setProperty("error", juce::String("No file path provided"));

                            completion(juce::var(result.get()));
                        }
                    })
                    .withNativeFunction ("setLTCOutput", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        juce::ignoreUnused(this);
                        // Args: [enabled, channel, frameRate] -> configures SMPTE LTC output
                        // Stub implementation — LTC generation not yet integrated
                        bool enabled = false;
                        int channel = 0;
                        double frameRate = 30.0;

                        if (args.size() >= 1)
                            enabled = (bool)args[0];
                        if (args.size() >= 2)
                            channel = (int)args[1];
                        if (args.size() >= 3)
                            frameRate = (double)args[2];

                        juce::Logger::writeToLog("setLTCOutput (stub): enabled=" + juce::String(enabled ? "true" : "false")
                            + " channel=" + juce::String(channel)
                            + " frameRate=" + juce::String(frameRate));

                        juce::DynamicObject::Ptr result = new juce::DynamicObject();
                        result->setProperty("enabled", enabled);
                        result->setProperty("channel", channel);
                        result->setProperty("frameRate", frameRate);
                        result->setProperty("stub", true);

                        completion(juce::var(result.get()));
                    })
                    // ===== Phase 16: Pro Audio & Compatibility =====
                    .withNativeFunction ("startLiveCapture", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        juce::ignoreUnused(this);
                        // Args: [format] -> starts capturing master output to file
                        // Stub implementation — live capture not yet integrated
                        juce::String format = "wav";
                        if (args.size() >= 1 && args[0].isString())
                            format = args[0].toString();

                        juce::String filePath = juce::File::getSpecialLocation(juce::File::tempDirectory)
                            .getChildFile("live_capture_" + juce::String(juce::Time::currentTimeMillis()) + "." + format)
                            .getFullPathName();

                        juce::Logger::writeToLog("startLiveCapture (stub): format=" + format + " path=" + filePath);

                        completion(juce::var(filePath));
                    })
                    .withNativeFunction ("stopLiveCapture", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        juce::ignoreUnused(this);
                        juce::ignoreUnused(args);
                        // Stub implementation — returns mock capture result
                        juce::Logger::writeToLog("stopLiveCapture (stub)");

                        juce::DynamicObject::Ptr result = new juce::DynamicObject();
                        result->setProperty("filePath", "");
                        result->setProperty("duration", 0.0);
                        result->setProperty("stub", true);

                        completion(juce::var(result.get()));
                    })
                    .withNativeFunction ("exportDDP", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        // Args: [sourceWavPath, outputDir, tracksJSON, catalogNumber?]
                        // tracksJSON: array of { startTime, endTime, title, isrc }
                        if (args.size() >= 3 && args[0].isString() && args[1].isString() && args[2].isArray()) {
                            juce::String sourceWavPath = args[0].toString();
                            juce::String outputDirPath = args[1].toString();
                            juce::String catalogNumber = args.size() >= 4 ? args[3].toString() : "";

                            std::vector<DDPExporter::CDTrack> tracks;
                            auto* arr = args[2].getArray();
                            for (int i = 0; i < arr->size(); ++i) {
                                auto& item = arr->getReference(i);
                                DDPExporter::CDTrack t;
                                if (auto* obj = item.getDynamicObject()) {
                                    t.startTime = (double)obj->getProperty("startTime");
                                    t.endTime   = (double)obj->getProperty("endTime");
                                    t.title     = obj->getProperty("title").toString();
                                    t.isrc      = obj->getProperty("isrc").toString();
                                } else {
                                    t.startTime = 0.0;
                                    t.endTime   = 0.0;
                                }
                                tracks.push_back(t);
                            }

                            bool ok = audioEngine.getDDPExporter().exportDDP(
                                juce::File(sourceWavPath), juce::File(outputDirPath), tracks, catalogNumber);

                            if (!ok) {
                                juce::Logger::writeToLog("exportDDP failed: " + audioEngine.getDDPExporter().getLastError());
                            }
                            completion(juce::var(ok));
                        } else {
                            juce::Logger::writeToLog("exportDDP: invalid arguments");
                            completion(juce::var(false));
                        }
                    })

                    // ==================== Window Management ====================
                    .withNativeFunction ("minimizeWindow", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        juce::ignoreUnused(args);
                       #if JUCE_WINDOWS
                        if (auto* peer = getTopLevelComponent()->getPeer())
                        {
                            auto hwnd = static_cast<HWND> (peer->getNativeHandle());
                            ::ShowWindow (hwnd, SW_MINIMIZE);
                        }
                       #endif
                        completion(juce::var());
                    })
                    .withNativeFunction ("maximizeWindow", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        juce::ignoreUnused(args);
                        bool isNowMaximized = false;
                       #if JUCE_WINDOWS
                        if (auto* peer = getTopLevelComponent()->getPeer())
                        {
                            auto hwnd = static_cast<HWND> (peer->getNativeHandle());
                            if (::IsZoomed (hwnd))
                            {
                                ::ShowWindow (hwnd, SW_RESTORE);
                                isNowMaximized = false;
                            }
                            else
                            {
                                ::ShowWindow (hwnd, SW_MAXIMIZE);
                                isNowMaximized = true;
                            }
                        }
                       #endif
                        completion(juce::var(isNowMaximized));
                    })
                    .withNativeFunction ("closeWindow", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        juce::ignoreUnused(args);
                        completion(juce::var());
                        juce::JUCEApplication::getInstance()->systemRequestedQuit();
                    })
                    .withNativeFunction ("isWindowMaximized", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        juce::ignoreUnused(args);
                        bool maximized = false;
                       #if JUCE_WINDOWS
                        if (auto* peer = getTopLevelComponent()->getPeer())
                        {
                            auto hwnd = static_cast<HWND> (peer->getNativeHandle());
                            maximized = ::IsZoomed (hwnd) != 0;
                        }
                       #endif
                        completion(juce::var(maximized));
                    })
                    .withNativeFunction ("startWindowDrag", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        juce::ignoreUnused(args);
                       #if JUCE_WINDOWS
                        if (auto* peer = getTopLevelComponent()->getPeer())
                        {
                            auto hwnd = static_cast<HWND> (peer->getNativeHandle());
                            ::ReleaseCapture();
                            ::SendMessage (hwnd, WM_NCLBUTTONDOWN, HTCAPTION, 0);
                        }
                       #endif
                        completion(juce::var());
                    })
                    // ========== Automation (Phase 1.1) ==========
                    .withNativeFunction ("setAutomationPoints", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        if (args.size() == 3) {
                            audioEngine.setAutomationPoints(args[0].toString(), args[1].toString(), args[2].toString());
                            completion(true);
                        } else {
                            completion(false);
                        }
                    })
                    .withNativeFunction ("setAutomationMode", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        if (args.size() == 3) {
                            audioEngine.setAutomationMode(args[0].toString(), args[1].toString(), args[2].toString());
                            completion(true);
                        } else {
                            completion(false);
                        }
                    })
                    .withNativeFunction ("getAutomationMode", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        if (args.size() == 2) {
                            auto mode = audioEngine.getAutomationMode(args[0].toString(), args[1].toString());
                            completion(juce::var(mode));
                        } else {
                            completion(juce::var("off"));
                        }
                    })
                    .withNativeFunction ("clearAutomation", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        if (args.size() == 2) {
                            audioEngine.clearAutomation(args[0].toString(), args[1].toString());
                            completion(true);
                        } else {
                            completion(false);
                        }
                    })
                    .withNativeFunction ("beginTouchAutomation", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        if (args.size() == 2) {
                            audioEngine.beginTouchAutomation(args[0].toString(), args[1].toString());
                            completion(true);
                        } else {
                            completion(false);
                        }
                    })
                    .withNativeFunction ("endTouchAutomation", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        if (args.size() == 2) {
                            audioEngine.endTouchAutomation(args[0].toString(), args[1].toString());
                            completion(true);
                        } else {
                            completion(false);
                        }
                    })
                    // Tempo Map (Phase 1.2)
                    .withNativeFunction ("setTempoMarkers", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        if (args.size() == 1) {
                            audioEngine.setTempoMarkers(args[0].toString());
                            completion(true);
                        } else {
                            completion(false);
                        }
                    })
                    .withNativeFunction ("clearTempoMarkers", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        juce::ignoreUnused(args);
                        audioEngine.clearTempoMarkers();
                        completion(true);
                    })
                    .withNativeFunction ("setPanLaw", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        if (args.size() >= 1) {
                            audioEngine.setPanLaw(args[0].toString());
                            completion(true);
                        } else {
                            completion(false);
                        }
                    })
                    .withNativeFunction ("getPanLaw", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        juce::ignoreUnused(args);
                        completion(audioEngine.getPanLaw());
                    })
                    .withNativeFunction ("setTrackDCOffset", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        if (args.size() >= 2) {
                            audioEngine.setTrackDCOffset(args[0].toString(), (bool)args[1]);
                            completion(true);
                        } else {
                            completion(false);
                        }
                    })
                    // Clip Gain Envelope (Phase 18.10)
                    .withNativeFunction ("setClipGainEnvelope", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        if (args.size() >= 3) {
                            audioEngine.setClipGainEnvelope(args[0].toString(), args[1].toString(), args[2].toString());
                            completion(true);
                        } else {
                            completion(false);
                        }
                    })
                    // MIDI Learn (Phase 19.7)
                    .withNativeFunction ("startMIDILearnForPlugin", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        if (args.size() >= 3) {
                            audioEngine.startMIDILearnForPlugin(args[0].toString(), static_cast<int>(args[1]), static_cast<int>(args[2]));
                            completion(true);
                        } else {
                            completion(false);
                        }
                    })
                    .withNativeFunction ("stopMIDILearn", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        juce::ignoreUnused(args);
                        audioEngine.stopMIDILearnMode();
                        completion(true);
                    })
                    .withNativeFunction ("clearMIDILearnMapping", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        if (args.size() >= 1) {
                            audioEngine.clearMIDILearnMapping(static_cast<int>(args[0]));
                            completion(true);
                        } else {
                            completion(false);
                        }
                    })
                    .withNativeFunction ("getMIDILearnMappings", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        juce::ignoreUnused(args);
                        completion(audioEngine.getMIDILearnMappings());
                    })
                    // MIDI Import/Export (Phase 19.9)
                    .withNativeFunction ("importMIDIFile", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        if (args.size() >= 1) {
                            completion(audioEngine.importMIDIFile(args[0].toString()));
                        } else {
                            completion(juce::var());
                        }
                    })
                    .withNativeFunction ("exportMIDIFile", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        if (args.size() >= 5) {
                            bool ok = audioEngine.exportMIDIFile(
                                args[0].toString(),  // trackId
                                args[1].toString(),  // clipId
                                args[2].toString(),  // eventsJSON
                                args[3].toString(),  // outputPath
                                static_cast<double>(args[4])  // clipTempo
                            );
                            completion(ok);
                        } else {
                            completion(false);
                        }
                    })
                    // Plugin Presets (Phase 19.14)
                    .withNativeFunction ("getPluginPresets", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        if (args.size() >= 3) {
                            completion(audioEngine.getPluginPresets(args[0].toString(), static_cast<int>(args[1]), (bool)args[2]));
                        } else {
                            completion(juce::var());
                        }
                    })
                    .withNativeFunction ("loadPluginPreset", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        if (args.size() >= 4) {
                            bool ok = audioEngine.loadPluginPreset(args[0].toString(), static_cast<int>(args[1]), (bool)args[2], args[3].toString());
                            completion(ok);
                        } else {
                            completion(false);
                        }
                    })
                    .withNativeFunction ("savePluginPreset", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        if (args.size() >= 5) {
                            bool ok = audioEngine.savePluginPreset(args[0].toString(), static_cast<int>(args[1]), (bool)args[2], args[3].toString(), args[4].toString());
                            completion(ok);
                        } else {
                            completion(false);
                        }
                    })
                    // A/B Comparison (Phase 19.16)
                    .withNativeFunction ("storePluginABState", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        if (args.size() >= 4) {
                            bool ok = audioEngine.storePluginABState(args[0].toString(), static_cast<int>(args[1]), (bool)args[2], args[3].toString());
                            completion(ok);
                        } else {
                            completion(false);
                        }
                    })
                    .withNativeFunction ("loadPluginABState", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        if (args.size() >= 4) {
                            bool ok = audioEngine.loadPluginABState(args[0].toString(), static_cast<int>(args[1]), (bool)args[2], args[3].toString());
                            completion(ok);
                        } else {
                            completion(false);
                        }
                    })
                    .withNativeFunction ("getPluginActiveSlot", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        if (args.size() >= 3) {
                            completion(audioEngine.getPluginActiveSlot(args[0].toString(), static_cast<int>(args[1]), (bool)args[2]));
                        } else {
                            completion(juce::String("A"));
                        }
                    })
                    // Session Archive (Phase 20.5)
                    .withNativeFunction ("archiveSession", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        if (args.size() >= 2) {
                            bool ok = audioEngine.archiveSession(args[0].toString(), args[1].toString());
                            completion(ok);
                        } else {
                            completion(false);
                        }
                    })
                    .withNativeFunction ("unarchiveSession", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        if (args.size() >= 2) {
                            bool ok = audioEngine.unarchiveSession(args[0].toString(), args[1].toString());
                            completion(ok);
                        } else {
                            completion(false);
                        }
                    })
                    // Phase Correlation Meter (Phase 20.10)
                    .withNativeFunction ("getPhaseCorrelation", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        juce::ignoreUnused(args);
                        completion(static_cast<double>(audioEngine.getPhaseCorrelation()));
                    })
                    // Spectrum Analyzer (Phase 20.11)
                    .withNativeFunction ("getSpectrumData", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        juce::ignoreUnused(args);
                        completion(audioEngine.getSpectrumData());
                    })
                    // Built-in FX Oversampling (Phase 20.12)
                    .withNativeFunction ("setBuiltInFXOversampling", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        if (args.size() >= 4) {
                            bool ok = audioEngine.setBuiltInFXOversampling(
                                args[0].toString(),            // trackId
                                static_cast<int>(args[1]),     // fxIndex
                                (bool)args[2],                 // isInputFX
                                (bool)args[3]                  // enabled
                            );
                            completion(ok);
                        } else {
                            completion(false);
                        }
                    })
                    // Channel Strip EQ (Phase 19.18)
                    .withNativeFunction ("setChannelStripEQEnabled", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        if (args.size() >= 2) {
                            audioEngine.setChannelStripEQEnabled(args[0].toString(), (bool)args[1]);
                            completion(true);
                        } else {
                            completion(false);
                        }
                    })
                    .withNativeFunction ("setChannelStripEQParam", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        if (args.size() >= 3) {
                            audioEngine.setChannelStripEQParam(
                                args[0].toString(),
                                static_cast<int>(args[1]),
                                static_cast<float>((double)args[2])
                            );
                            completion(true);
                        } else {
                            completion(false);
                        }
                    })
                    .withNativeFunction ("getChannelStripEQParam", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        if (args.size() >= 2) {
                            completion(static_cast<double>(audioEngine.getChannelStripEQParam(
                                args[0].toString(),
                                static_cast<int>(args[1])
                            )));
                        } else {
                            completion(0.0);
                        }
                    })
                    .withNativeFunction ("getPitchCorrectorData", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        if (args.size() >= 2)
                            completion(audioEngine.getPitchCorrectorData(args[0].toString(), static_cast<int>(args[1])));
                        else
                            completion(juce::var());
                    })
                    .withNativeFunction ("setPitchCorrectorParam", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        if (args.size() >= 4)
                        {
                            audioEngine.setPitchCorrectorParam(args[0].toString(), static_cast<int>(args[1]),
                                                               args[2].toString(), static_cast<float>(static_cast<double>(args[3])));
                            completion(true);
                        }
                        else
                            completion(false);
                    })
                    .withNativeFunction ("getPitchHistory", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        if (args.size() >= 3)
                            completion(audioEngine.getPitchHistory(args[0].toString(), static_cast<int>(args[1]), static_cast<int>(args[2])));
                        else
                            completion(juce::Array<juce::var>());
                    })
                    .withNativeFunction ("analyzePitchContour", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        if (args.size() >= 2)
                        {
                            auto trackId = args[0].toString();
                            auto clipId  = args[1].toString();
                            // Fire-and-forget: start analysis, emit event when done
                            if (pitchAnalysisRunning.load())
                            {
                                auto obj = std::make_unique<juce::DynamicObject>();
                                obj->setProperty ("started", false);
                                obj->setProperty ("error", "Analysis already in progress");
                                completion (juce::var (obj.release()));
                                return;
                            }
                            pitchAnalysisRunning.store (true);
                            auto obj = std::make_unique<juce::DynamicObject>();
                            obj->setProperty ("started", true);
                            completion (juce::var (obj.release()));

                            std::thread([this, trackId, clipId]() {
                                juce::Logger::writeToLog ("PitchAnalysis: Starting for track=" + trackId + " clip=" + clipId);
                                auto result = audioEngine.analyzePitchContour(trackId, clipId);
                                pitchAnalysisRunning.store (false);

                                int noteCount = 0;
                                bool hasResult = false;
                                if (auto* obj = result.getDynamicObject())
                                {
                                    auto notesVar = obj->getProperty ("notes");
                                    noteCount = notesVar.isArray() ? notesVar.getArray()->size() : 0;
                                    hasResult = true;
                                    juce::Logger::writeToLog ("PitchAnalysis: Complete — "
                                        + juce::String(noteCount) + " notes detected, clipId=" + clipId);
                                }
                                else
                                {
                                    juce::Logger::writeToLog ("PitchAnalysis: Result is VOID/empty!");
                                }

                                {
                                    const juce::ScopedLock sl (pitchResultLock);
                                    lastPitchAnalysisResult = result;
                                }

                                juce::MessageManager::callAsync ([this, clipId, noteCount, hasResult]() {
                                    auto notification = std::make_unique<juce::DynamicObject>();
                                    notification->setProperty ("clipId", clipId);
                                    notification->setProperty ("noteCount", noteCount);
                                    notification->setProperty ("ready", hasResult);
                                    juce::Logger::writeToLog ("PitchAnalysis: Emitting lightweight event (noteCount="
                                        + juce::String(noteCount) + ")");
                                    webView.emitEventIfBrowserIsVisible ("pitchAnalysisComplete",
                                        juce::var (notification.release()));
                                });
                            }).detach();
                        }
                        else
                            completion(juce::var());
                    })
                    .withNativeFunction ("analyzePitchContourDirect", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        if (args.size() >= 4)
                        {
                            auto filePath = args[0].toString();
                            auto offset   = static_cast<double>(args[1]);
                            auto duration  = static_cast<double>(args[2]);
                            auto clipId    = args[3].toString();
                            // Fire-and-forget: start analysis, emit event when done
                            if (pitchAnalysisRunning.load())
                            {
                                auto obj = std::make_unique<juce::DynamicObject>();
                                obj->setProperty ("started", false);
                                obj->setProperty ("error", "Analysis already in progress");
                                completion (juce::var (obj.release()));
                                return;
                            }
                            pitchAnalysisRunning.store (true);
                            auto obj = std::make_unique<juce::DynamicObject>();
                            obj->setProperty ("started", true);
                            completion (juce::var (obj.release()));

                            std::thread([this, filePath, offset, duration, clipId]() {
                                juce::Logger::writeToLog ("PitchAnalysis: Starting for " + filePath
                                    + " offset=" + juce::String(offset) + " dur=" + juce::String(duration));
                                auto result = audioEngine.analyzePitchContourDirect(filePath, offset, duration, clipId);
                                pitchAnalysisRunning.store (false);

                                int noteCount = 0;
                                bool hasResult = false;
                                if (auto* obj = result.getDynamicObject())
                                {
                                    auto notesVar = obj->getProperty ("notes");
                                    noteCount = notesVar.isArray() ? notesVar.getArray()->size() : 0;
                                    hasResult = true;
                                    juce::Logger::writeToLog ("PitchAnalysis: Complete — "
                                        + juce::String(noteCount) + " notes detected, clipId=" + clipId);
                                }
                                else
                                {
                                    juce::Logger::writeToLog ("PitchAnalysis: Result is VOID/empty!");
                                }

                                // Store result for fetch-after-event pattern (avoids large event payload)
                                {
                                    const juce::ScopedLock sl (pitchResultLock);
                                    lastPitchAnalysisResult = result;
                                }

                                juce::MessageManager::callAsync ([this, clipId, noteCount, hasResult]() {
                                    // Send lightweight notification with metadata only
                                    auto notification = std::make_unique<juce::DynamicObject>();
                                    notification->setProperty ("clipId", clipId);
                                    notification->setProperty ("noteCount", noteCount);
                                    notification->setProperty ("ready", hasResult);
                                    juce::Logger::writeToLog ("PitchAnalysis: Emitting lightweight event (noteCount="
                                        + juce::String(noteCount) + ")");
                                    webView.emitEventIfBrowserIsVisible ("pitchAnalysisComplete",
                                        juce::var (notification.release()));
                                });
                            }).detach();
                        }
                        else
                            completion(juce::var());
                    })
                    .withNativeFunction ("getLastPitchAnalysisResult", [this] (const juce::Array<juce::var>& /*args*/, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        const juce::ScopedLock sl (pitchResultLock);
                        completion (lastPitchAnalysisResult);
                    })
                    .withNativeFunction ("applyPitchCorrection", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        if (args.size() >= 3)
                        {
                            juce::String trackId = args[0].toString();
                            juce::String clipId  = args[1].toString();
                            juce::var    notes   = args[2];
                            juce::var    frames  = (args.size() >= 4) ? args[3] : juce::var();
                            // Return immediately — re-synthesis is expensive (seconds).
                            // Discard any stale queued-but-not-yet-started jobs so they don't
                            // pile up and corrupt the output file with stale note data.
                            // The currently-running job (if any) is allowed to finish safely.
                            pitchCorrectionPool.removeAllJobs (false, 0);
                            completion(true);
                            pitchCorrectionPool.addJob ([this, trackId, clipId, notes, frames]() mutable {
                                juce::Logger::writeToLog ("PitchCorrection: job starting for clip " + clipId);
                                auto result = audioEngine.applyPitchCorrection(trackId, clipId, notes, frames);
                                bool success = result.isObject();
                                juce::String outputFile = (success && result["outputFile"].isString())
                                    ? result["outputFile"].toString() : juce::String();
                                juce::Logger::writeToLog ("PitchCorrection: job finished for clip " + clipId
                                    + " success=" + juce::String(success ? "true" : "false")
                                    + " outputFile=" + outputFile);
                                juce::MessageManager::callAsync ([this, clipId, success, outputFile]() {
                                    juce::Logger::writeToLog ("PitchCorrection: Emitting pitchCorrectionComplete event, outputFile=" + outputFile);
                                    auto obj = std::make_unique<juce::DynamicObject>();
                                    obj->setProperty ("clipId", clipId);
                                    obj->setProperty ("success", success);
                                    obj->setProperty ("outputFile", outputFile);
                                    webView.emitEventIfBrowserIsVisible ("pitchCorrectionComplete",
                                        juce::var (obj.release()));
                                });
                            });
                        }
                        else
                            completion(false);
                    })
                    .withNativeFunction ("previewPitchCorrection", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        if (args.size() >= 3)
                            completion(audioEngine.previewPitchCorrection(args[0].toString(), args[1].toString(), args[2]));
                        else
                            completion(false);
                    })
                    .withNativeFunction ("analyzePolyphonic", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        if (args.size() >= 2)
                        {
                            auto trackId = args[0].toString();
                            auto clipId  = args[1].toString();
                            // Run on background thread to avoid blocking UI
                            std::thread([this, trackId, clipId, completion]() {
                                auto result = audioEngine.analyzePolyphonic(trackId, clipId);
                                completion(result);
                            }).detach();
                        }
                        else
                            completion(juce::var());
                    })
                    .withNativeFunction ("extractMidiFromAudio", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        if (args.size() >= 2)
                            completion(audioEngine.extractMidiFromAudio(args[0].toString(), args[1].toString()));
                        else
                            completion(juce::var());
                    })
                    .withNativeFunction ("isPolyphonicDetectionAvailable", [this] (const juce::Array<juce::var>&, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        completion(audioEngine.isPolyphonicDetectionAvailable());
                    })
                    .withNativeFunction ("applyPolyPitchCorrection", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        if (args.size() >= 3)
                            completion(audioEngine.applyPolyPitchCorrection(args[0].toString(), args[1].toString(), args[2]));
                        else
                            completion(false);
                    })
                    .withNativeFunction ("soloPolyNote", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        if (args.size() >= 3)
                            completion(audioEngine.soloPolyNote(args[0].toString(), args[1].toString(), args[2].toString()));
                        else
                            completion(juce::var());
                    })
                    .withNativeFunction ("setClipPitchPreview", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        // args[0] = clipId, args[1] = JSON array of {startTime, endTime, pitchRatio}
                        if (args.size() >= 2)
                        {
                            juce::String clipId = args[0].toString();
                            auto segArray = args[1].getArray();
                            std::vector<PlaybackEngine::PitchCorrectionSegment> segments;

                            if (segArray != nullptr)
                            {
                                for (const auto& seg : *segArray)
                                {
                                    PlaybackEngine::PitchCorrectionSegment s;
                                    s.startTime  = static_cast<double> (seg.getProperty ("startTime", 0.0));
                                    s.endTime    = static_cast<double> (seg.getProperty ("endTime", 0.0));
                                    s.pitchRatio = static_cast<float> (static_cast<double> (seg.getProperty ("pitchRatio", 1.0)));
                                    segments.push_back (s);
                                }
                            }

                            audioEngine.getPlaybackEngine().setClipPitchPreview (clipId, segments);
                            completion (true);
                        }
                        else
                            completion (false);
                    })
                    .withNativeFunction ("clearClipPitchPreview", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        if (args.size() >= 1)
                        {
                            audioEngine.getPlaybackEngine().clearClipPitchPreview (args[0].toString());
                            completion (true);
                        }
                        else
                            completion (false);
                    })
                    .withNativeFunction ("separateStems", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        if (args.size() >= 2)
                            completion(audioEngine.separateStems(args[0].toString(), args[1].toString()));
                        else
                            completion(juce::var());
                    })
                    .withNativeFunction ("isStemSeparationAvailable", [this] (const juce::Array<juce::var>&, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        completion(audioEngine.isStemSeparationAvailable());
                    })
                    .withNativeFunction ("separateStemsAsync", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        if (args.size() >= 3)
                            completion(audioEngine.separateStemsAsync(args[0].toString(), args[1].toString(), args[2].toString()));
                        else
                            completion(juce::var());
                    })
                    .withNativeFunction ("getStemSeparationProgress", [this] (const juce::Array<juce::var>&, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        completion(audioEngine.getStemSeparationProgress());
                    })
                    .withNativeFunction ("cancelStemSeparation", [this] (const juce::Array<juce::var>&, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        audioEngine.cancelStemSeparation();
                        completion(juce::var());
                    })
                    .withNativeFunction ("initializeARA", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        if (args.size() >= 2)
                            completion(audioEngine.initializeARAForTrack(args[0].toString(), static_cast<int>(args[1])));
                        else
                            completion(juce::var());
                    })
                    .withNativeFunction ("addARAClip", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        if (args.size() >= 2)
                            completion(audioEngine.addARAClip(args[0].toString(), args[1].toString()));
                        else
                            completion(juce::var());
                    })
                    .withNativeFunction ("removeARAClip", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        if (args.size() >= 2)
                            completion(audioEngine.removeARAClip(args[0].toString(), args[1].toString()));
                        else
                            completion(juce::var());
                    })
                    .withNativeFunction ("getARAPlugins", [this] (const juce::Array<juce::var>&, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        completion(audioEngine.getARAPlugins());
                    })
                    .withNativeFunction ("shutdownARA", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        if (args.size() >= 1)
                            completion(audioEngine.shutdownARAForTrack(args[0].toString()));
                        else
                            completion(juce::var());
                    }))
{
    // Check if options are supported
    auto checkOptions = juce::WebBrowserComponent::Options()
                            .withBackend(juce::WebBrowserComponent::Options::Backend::webview2);
                            
    bool supported = juce::WebBrowserComponent::areOptionsSupported(checkOptions);
    juce::Logger::writeToLog("WebView2 Supported: " + juce::String(supported ? "Yes" : "No"));

    if (supported)
    {
        addAndMakeVisible (webView);
    }
    else
    {
        juce::Logger::writeToLog("WebView2 NOT supported. Cannot show UI.");
        // Maybe add a fallback label here if I wanted to be fancy, but log is enough for now.
    }

    // When a peak cache file finishes generating for a recorded clip, emit a JS event
    // so the Timeline can refresh the waveform display without waiting for user interaction.
    audioEngine.onPeaksReady = [this] (const juce::String& filePath)
    {
        juce::DynamicObject::Ptr data = new juce::DynamicObject();
        data->setProperty ("filePath", filePath);
        webView.emitEventIfBrowserIsVisible ("peaksReady", juce::var (data.get()));
    };

    // Development URL (Vite default)
    // In production, this will use getResourceProviderRootUrl()
    #if JUCE_DEBUG
        juce::Logger::writeToLog("Loading from localhost:5173");
        webView.goToURL("http://localhost:5173");
    #else
        // TODO: Switch to internal resource provider URL for release
        // webView.goToURL(juce::WebBrowserComponent::getResourceProviderRoot().toString());
        webView.goToURL("http://localhost:5173"); // Fallback for now until BinaryData is set up
    #endif

    setSize (1024, 768);
    
    startTimerHz (10); // Start metering loop at 10 FPS (was 30)
    juce::Logger::writeToLog("MainComponent initialized successfully");
}

MainComponent::~MainComponent()
{
    stopTimer();
}

//==============================================================================
void MainComponent::timerCallback()
{
    // Broadcast transport position to frontend for playhead movement
    if (audioEngine.isTransportPlaying())
    {
        double position = audioEngine.getTransportPosition();
        
        // Create JSON object with transport state
        juce::DynamicObject::Ptr transportData = new juce::DynamicObject();
        transportData->setProperty("position", position);
        transportData->setProperty("isPlaying", true);
        
        // Emit event to frontend
        webView.emitEventIfBrowserIsVisible("transportUpdate", juce::var(transportData.get()));
    }
    
    // Check for completed clips and emit events - REMOVED to allow explicit fetching via native function
    /*
    auto completedClips = audioEngine.getLastCompletedClips();
    for (const auto& clip : completedClips)
    {
        juce::DynamicObject::Ptr clipData = new juce::DynamicObject();
        clipData->setProperty("trackId", clip.trackId);
        clipData->setProperty("filePath", clip.file.getFullPathName());
        clipData->setProperty("startTime", clip.startTime);
        clipData->setProperty("duration", clip.duration);
        clipData->setProperty("name", clip.file.getFileNameWithoutExtension());
        
        webView.emitEventIfBrowserIsVisible("clipRecorded", juce::var(clipData.get()));
    }
    */
    
    // ========== Event-Based Metering ==========
    // Emit meter levels as events to frontend (every ~33ms at 30Hz)
    juce::var meterData(new juce::DynamicObject());
    auto* obj = meterData.getDynamicObject();
    
    // Get track meter levels
    auto trackLevels = audioEngine.getMeterLevels();
    obj->setProperty("trackLevels", trackLevels);
    
    // Get master level
    float masterLevel = audioEngine.getMasterLevel();
    obj->setProperty("masterLevel", masterLevel);
    
    // Add timestamp
    obj->setProperty("timestamp", juce::Time::currentTimeMillis());
    
    // Emit custom event to JavaScript
    webView.emitEventIfBrowserIsVisible("meterUpdate", meterData);
}

//==============================================================================
void MainComponent::paint (juce::Graphics& g)
{
    // (Our component is opaque, so we must completely fill the background with a solid colour)
    g.fillAll (getLookAndFeel().findColour (juce::ResizableWindow::backgroundColourId));
}

void MainComponent::resized()
{
    // This is called when the MainComponent is resized.
    // If you add any child components, this is where you should
    // update their positions.
    webView.setBounds(getLocalBounds());
}
