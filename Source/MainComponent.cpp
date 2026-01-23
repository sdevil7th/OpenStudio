#include "MainComponent.h"

//==============================================================================
MainComponent::MainComponent()
    : webView (juce::WebBrowserComponent::Options()
                   .withBackend (juce::WebBrowserComponent::Options::Backend::webview2)
                   .withNativeIntegrationEnabled()
                   .withResourceProvider ([this] (const juce::String& url) -> std::optional<juce::WebBrowserComponent::Resource> {
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
                       juce::String trackId = audioEngine.addTrack();
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
                       completion(audioEngine.getMeterLevels());
                   })
                   .withNativeFunction ("getMasterLevel", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
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
                   // Plugin Management
                   .withNativeFunction ("scanForPlugins", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                       juce::Logger::writeToLog("MainComponent: scanForPlugins called from frontend");
                       audioEngine.scanForPlugins();
                       int numPlugins = audioEngine.getAvailablePlugins().size();
                       juce::String message = "Scan complete!\nFound " + juce::String(numPlugins) + " plugins.";
                       juce::AlertWindow::showMessageBoxAsync(juce::AlertWindow::InfoIcon, "Plugin Scan", message);
                       juce::Logger::writeToLog("MainComponent: Scan complete. Found " + juce::String(numPlugins) + " plugins");
                       completion(true);
                   })
                   .withNativeFunction ("getAvailablePlugins", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                       completion(audioEngine.getAvailablePlugins());
                   })
                   .withNativeFunction ("addTrackInputFX", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                       if (args.size() == 2) {
                           juce::String trackId = args[0].toString();
                           juce::String pluginPath = args[1].toString();
                           bool success = audioEngine.addTrackInputFX(trackId, pluginPath);
                           completion(success);
                       } else {
                           completion(false);
                       }
                   })
                   .withNativeFunction ("addTrackFX", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                       if (args.size() == 2) {
                           juce::String trackId = args[0].toString();
                           juce::String pluginPath = args[1].toString();
                           bool success = audioEngine.addTrackFX(trackId, pluginPath);
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
                   // Master Controls
                   .withNativeFunction ("setMasterVolume", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                       if (args.size() == 1) {
                           float volume = args[0];
                           audioEngine.setMasterVolume(volume);
                           completion(true);
                       } else {
                           completion(false);
                       }
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
                   // Transport Position
                   .withNativeFunction ("getTransportPosition", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
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
                    .withNativeFunction ("setTimeSignature", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        if (args.size() == 2 && args[0].isInt() && args[1].isInt()) {
                            audioEngine.setTimeSignature(args[0], args[1]);
                            completion(true);
                        } else {
                            completion(false);
                        }
                    })
                    .withNativeFunction ("getTimeSignature", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        juce::DynamicObject* result = new juce::DynamicObject();
                        int num, den;
                        audioEngine.getTimeSignature(num, den);
                        result->setProperty("numerator", num);
                        result->setProperty("denominator", den);
                        completion(result);
                    })
                    // Recording
                    .withNativeFunction ("getLastCompletedClips", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
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
                   // Playback clip management
                   .withNativeFunction ("addPlaybackClip", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        if (args.size() == 4 && args[1].isString() && args[2].isDouble() && args[3].isDouble()) {
                            juce::String trackId = args[0].toString();
                            juce::String filePath = args[1].toString();
                            double startTime = args[2];
                            double duration = args[3];
                            audioEngine.addPlaybackClip(trackId, filePath, startTime, duration);
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
                        audioEngine.clearPlaybackClips();
                        completion(true);
                    })
                    // MIDI Device Management (Phase 2)
                    .withNativeFunction ("getMIDIInputDevices", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
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
