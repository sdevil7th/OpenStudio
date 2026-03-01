#include "MainComponent.h"
#include <set>

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
                                                    .getChildFile ("WebView2UserData")))
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
                                   
                                   console.log("[JUCE] Invoking native function:", name, "with args:", args, "resultId:", resultId);
                                   
                                   // Timeout after 15 seconds (audio device enumeration can take time)
                                   const timeout = setTimeout(() => {
                                       window.__JUCE__.backend.removeEventListener(listener);
                                       reject(new Error("Native function call timeout: " + name));
                                   }, 15000);
                                   
                                   const listener = window.__JUCE__.backend.addEventListener('__juce__complete', (data) => {
                                       console.log("[JUCE] Received __juce__complete event:", data);
                                       if (data.promiseId === resultId) {
                                           clearTimeout(timeout);
                                           window.__JUCE__.backend.removeEventListener(listener);
                                           console.log("[JUCE] Resolving promise for", name, "with:", data.result);
                                           resolve(data.result);
                                       }
                                   });
                                   
                                   console.log("[JUCE] Emitting __juce__invoke event...");
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
                   // Waveform Visualization
                   .withNativeFunction ("getWaveformPeaks", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                       if (args.size() == 3) {
                           juce::String filePath = args[0].toString();
                           int samplesPerPixel = args[1];
                           int numPixels = args[2];
                           completion(audioEngine.getWaveformPeaks(filePath, samplesPerPixel, numPixels));
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
                        // Accepts 4-8 args: trackId, filePath, startTime, duration, [offset], [volumeDB], [fadeIn], [fadeOut]
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
                            audioEngine.addPlaybackClip(trackId, filePath, startTime, duration, offset, volumeDB, fadeIn, fadeOut);
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
                        // Args: [filePath, factor] -> returns new file path or empty string on failure
                        // Uses FFmpeg with atempo filter as a simple approach
                        if (args.size() >= 2 && args[0].isString()) {
                            juce::String filePath = args[0].toString();
                            double factor = (double)args[1];

                            juce::File inputFile(filePath);
                            juce::File outputFile = inputFile.getSiblingFile(
                                inputFile.getFileNameWithoutExtension() + "_stretched" + inputFile.getFileExtension()
                            );

                            // Try FFmpeg-based time stretch
                            juce::File ffmpeg(juce::File::getSpecialLocation(juce::File::currentApplicationFile)
                                .getSiblingFile("tools").getChildFile("ffmpeg.exe"));

                            if (!ffmpeg.existsAsFile()) {
                                // Fallback: check PATH
                                ffmpeg = juce::File("ffmpeg");
                            }

                            std::thread([filePath, outputFile, factor, ffmpeg,
                                         completion = std::make_shared<juce::WebBrowserComponent::NativeFunctionCompletion>(std::move(completion))]() {
                                juce::String cmd = ffmpeg.getFullPathName() + " -y -i \"" + filePath + "\" -af \"atempo=" + juce::String(factor) + "\" \"" + outputFile.getFullPathName() + "\"";
                                int exitCode = std::system(cmd.toRawUTF8());

                                juce::String result = (exitCode == 0 && outputFile.existsAsFile()) ? outputFile.getFullPathName() : "";
                                juce::MessageManager::callAsync([completion, result]() { (*completion)(result); });
                            }).detach();
                        } else {
                            completion(juce::String());
                        }
                    })
                    .withNativeFunction ("pitchShiftClip", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        juce::ignoreUnused(this);
                        // Args: [filePath, semitones] -> returns new file path or empty string
                        if (args.size() >= 2 && args[0].isString()) {
                            juce::String filePath = args[0].toString();
                            double semitones = (double)args[1];

                            juce::File inputFile(filePath);
                            juce::File outputFile = inputFile.getSiblingFile(
                                inputFile.getFileNameWithoutExtension() + "_pitched" + inputFile.getFileExtension()
                            );

                            // Convert semitones to frequency ratio: ratio = 2^(semitones/12)
                            double ratio = std::pow(2.0, semitones / 12.0);

                            juce::File ffmpeg(juce::File::getSpecialLocation(juce::File::currentApplicationFile)
                                .getSiblingFile("tools").getChildFile("ffmpeg.exe"));

                            if (!ffmpeg.existsAsFile()) {
                                ffmpeg = juce::File("ffmpeg");
                            }

                            std::thread([filePath, outputFile, ratio, ffmpeg,
                                         completion = std::make_shared<juce::WebBrowserComponent::NativeFunctionCompletion>(std::move(completion))]() {
                                // Use asetrate + aresample to pitch shift without time stretch
                                juce::String cmd = ffmpeg.getFullPathName() + " -y -i \"" + filePath + "\" -af \"asetrate=44100*" + juce::String(ratio) + ",aresample=44100\" \"" + outputFile.getFullPathName() + "\"";
                                int exitCode = std::system(cmd.toRawUTF8());

                                juce::String result = (exitCode == 0 && outputFile.existsAsFile()) ? outputFile.getFullPathName() : "";
                                juce::MessageManager::callAsync([completion, result]() { (*completion)(result); });
                            }).detach();
                        } else {
                            completion(juce::String());
                        }
                    })
                    // ========== Phase 15: Video, Scripting, LTC ==========
                    .withNativeFunction ("openVideoFile", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        juce::ignoreUnused(this);
                        // Args: [filePath] -> returns JSON with width, height, duration, fps
                        // Stub implementation — full FFmpeg video decoding is not yet integrated
                        if (args.size() >= 1 && args[0].isString()) {
                            juce::String filePath = args[0].toString();
                            juce::Logger::writeToLog("openVideoFile (stub): " + filePath);

                            juce::DynamicObject::Ptr result = new juce::DynamicObject();
                            result->setProperty("width", 1920);
                            result->setProperty("height", 1080);
                            result->setProperty("duration", 60.0);
                            result->setProperty("fps", 30.0);
                            result->setProperty("filePath", filePath);
                            result->setProperty("stub", true);

                            completion(juce::var(result.get()));
                        } else {
                            completion(juce::var());
                        }
                    })
                    .withNativeFunction ("getVideoFrame", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        juce::ignoreUnused(this);
                        // Args: [time] -> returns base64-encoded frame image at given time
                        // Stub implementation — returns empty string
                        if (args.size() >= 1) {
                            double timePos = (double)args[0];
                            juce::ignoreUnused(timePos);
                            juce::Logger::writeToLog("getVideoFrame (stub): t=" + juce::String(timePos));
                        }
                        completion(juce::String(""));
                    })
                    .withNativeFunction ("closeVideoFile", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        juce::ignoreUnused(this);
                        juce::ignoreUnused(args);
                        // Stub implementation — no video file currently open
                        juce::Logger::writeToLog("closeVideoFile (stub)");
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
                        juce::ignoreUnused(this);
                        // Args: [outputDir, regions_array] -> exports DDP disc image
                        // Stub implementation — DDP export not yet integrated
                        juce::String outputDir = "";
                        if (args.size() >= 1 && args[0].isString())
                            outputDir = args[0].toString();

                        int regionCount = 0;
                        if (args.size() >= 2 && args[1].isArray())
                            regionCount = args[1].getArray()->size();

                        juce::Logger::writeToLog("exportDDP (stub): outputDir=" + outputDir
                            + " regions=" + juce::String(regionCount));

                        // Stub: return true (success) for now
                        completion(juce::var(true));
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
