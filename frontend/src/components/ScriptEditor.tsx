import { useState, useRef, useEffect, useCallback } from "react";
import { X, Play, Trash2, Plus, Save, FolderOpen, RefreshCw } from "lucide-react";
import { useDAWStore } from "../store/useDAWStore";
import { useShallow } from "zustand/shallow";
import { Button } from "./ui";
import { nativeBridge } from "../services/NativeBridge";

interface NativeScript {
  name: string;
  filePath: string;
  description: string;
  isStock: boolean;
}

export function ScriptEditor() {
  const { showScriptEditor, scriptConsoleOutput, userScripts } = useDAWStore(useShallow((s) => ({
    showScriptEditor: s.showScriptEditor,
    scriptConsoleOutput: s.scriptConsoleOutput,
    userScripts: s.userScripts,
  })));

  const [code, setCode] = useState(
    "-- OpenStudio Lua Script\n-- API: s13.play(), s13.stop(), s13.getTempo(), s13.setTempo(bpm)\n-- s13.addTrack(), s13.removeTrack(id), s13.setTrackVolume(id, db)\n-- s13.print(msg) outputs to this console\n\ns13.print('Hello from OpenStudio!')\ns13.print('Tempo: ' .. s13.getTempo() .. ' BPM')\n",
  );
  const [selectedScriptId, setSelectedScriptId] = useState<string | null>(null);
  const [isRunning, setIsRunning] = useState(false);
  const [nativeScripts, setNativeScripts] = useState<NativeScript[]>([]);
  const [activeTab, setActiveTab] = useState<"editor" | "files">("editor");
  const consoleEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    consoleEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [scriptConsoleOutput]);

  const loadNativeScripts = useCallback(async () => {
    try {
      const scripts = await nativeBridge.listScripts();
      setNativeScripts(scripts);
    } catch {
      // Ignore — backend may not support listScripts yet
    }
  }, []);

  useEffect(() => {
    if (showScriptEditor) {
      loadNativeScripts();
    }
  }, [showScriptEditor, loadNativeScripts]);

  const handleRun = async () => {
    setIsRunning(true);
    useDAWStore.getState().appendScriptConsole("--- Running script ---");
    await useDAWStore.getState().executeScript(code);
    setIsRunning(false);
  };

  const handleRunFile = async (filePath: string) => {
    setIsRunning(true);
    useDAWStore.getState().appendScriptConsole(`--- Running: ${filePath.split(/[\\/]/).pop()} ---`);
    try {
      const result = await nativeBridge.loadScriptFile(filePath);
      if (result.result) useDAWStore.getState().appendScriptConsole(`> ${result.result}`);
      if (result.error) useDAWStore.getState().appendScriptConsole(`Error: ${result.error}`);
    } catch (err) {
      useDAWStore.getState().appendScriptConsole(`Error: ${err}`);
    }
    setIsRunning(false);
  };

  const handleSave = () => {
    const name = prompt("Script name:", "My Script");
    if (name) {
      useDAWStore.getState().addUserScript(name, code);
    }
  };

  const handleLoadScript = (scriptId: string) => {
    const script = userScripts.find((s) => s.id === scriptId);
    if (script) {
      setCode(script.code);
      setSelectedScriptId(scriptId);
      setActiveTab("editor");
    }
  };

  const handleOpenScriptsFolder = async () => {
    try {
      const dir = await nativeBridge.getScriptDirectory();
      if (dir) {
        await nativeBridge.openFileExternal(dir);
      }
    } catch {
      // Ignore
    }
  };

  if (!showScriptEditor) return null;

  return (
    <div className="fixed inset-8 z-2000 bg-neutral-900 border border-neutral-700 rounded-lg shadow-2xl flex flex-col overflow-hidden">
      {/* Header */}
      <div className="h-7 bg-neutral-800 border-b border-neutral-700 flex items-center justify-between px-3 shrink-0">
        <span className="text-[10px] font-semibold text-neutral-300 uppercase tracking-wider">
          Script Editor (Lua)
        </span>
        <div className="flex items-center gap-1">
          <Button
            variant="primary"
            size="sm"
            onClick={handleRun}
            disabled={isRunning}
            className="text-[10px] px-2 py-0.5"
          >
            <Play size={10} className="mr-1" />
            {isRunning ? "Running..." : "Run"}
          </Button>
          <Button variant="default" size="sm" onClick={handleSave} className="text-[10px] px-2 py-0.5">
            <Save size={10} className="mr-1" />
            Save
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => useDAWStore.getState().toggleScriptEditor()}
            title="Close"
          >
            <X size={14} />
          </Button>
        </div>
      </div>

      <div className="flex flex-1 min-h-0">
        {/* Script list sidebar */}
        <div className="w-52 bg-neutral-850 border-r border-neutral-700 flex flex-col shrink-0">
          {/* Sidebar tabs */}
          <div className="flex border-b border-neutral-700">
            <button
              className={`flex-1 text-[9px] py-1 uppercase ${activeTab === "editor" ? "text-neutral-200 bg-neutral-800" : "text-neutral-500 hover:text-neutral-300"}`}
              onClick={() => setActiveTab("editor")}
            >
              My Scripts
            </button>
            <button
              className={`flex-1 text-[9px] py-1 uppercase ${activeTab === "files" ? "text-neutral-200 bg-neutral-800" : "text-neutral-500 hover:text-neutral-300"}`}
              onClick={() => setActiveTab("files")}
            >
              Lua Files
            </button>
          </div>

          {activeTab === "editor" ? (
            <>
              <div className="flex items-center justify-between px-2 py-1 border-b border-neutral-700">
                <span className="text-[9px] text-neutral-500 uppercase">Saved</span>
                <Button variant="ghost" size="icon-sm" onClick={handleSave} title="New Script">
                  <Plus size={10} />
                </Button>
              </div>
              <div className="flex-1 overflow-y-auto">
                {userScripts.length === 0 ? (
                  <div className="text-[9px] text-neutral-600 text-center py-4">No saved scripts</div>
                ) : (
                  userScripts.map((script) => (
                    <div
                      key={script.id}
                      className={`group flex items-center justify-between px-2 py-1 cursor-pointer hover:bg-neutral-800 text-[10px] ${
                        selectedScriptId === script.id ? "bg-neutral-800 text-white" : "text-neutral-400"
                      }`}
                      onClick={() => handleLoadScript(script.id)}
                    >
                      <span className="truncate">{script.name}</span>
                      <button
                        className="opacity-0 group-hover:opacity-100 p-0.5 hover:text-red-400"
                        onClick={(e) => {
                          e.stopPropagation();
                          useDAWStore.getState().removeUserScript(script.id);
                        }}
                      >
                        <Trash2 size={9} />
                      </button>
                    </div>
                  ))
                )}
              </div>
            </>
          ) : (
            <>
              <div className="flex items-center justify-between px-2 py-1 border-b border-neutral-700">
                <span className="text-[9px] text-neutral-500 uppercase">Available</span>
                <div className="flex gap-0.5">
                  <Button variant="ghost" size="icon-sm" onClick={loadNativeScripts} title="Refresh">
                    <RefreshCw size={9} />
                  </Button>
                  <Button variant="ghost" size="icon-sm" onClick={handleOpenScriptsFolder} title="Open Scripts Folder">
                    <FolderOpen size={9} />
                  </Button>
                </div>
              </div>
              <div className="flex-1 overflow-y-auto">
                {nativeScripts.length === 0 ? (
                  <div className="text-[9px] text-neutral-600 text-center py-4">
                    No .lua scripts found.
                    <br />
                    Place scripts in Documents/OpenStudio/Scripts/
                  </div>
                ) : (
                  nativeScripts.map((script) => (
                    <div
                      key={script.filePath}
                      className="group flex items-center justify-between px-2 py-1 cursor-pointer hover:bg-neutral-800 text-[10px] text-neutral-400"
                      onClick={() => handleRunFile(script.filePath)}
                      title={script.description || script.filePath}
                    >
                      <div className="flex flex-col min-w-0">
                        <span className="truncate">
                          {script.isStock && (
                            <span className="text-[8px] text-lime-500 mr-1">STOCK</span>
                          )}
                          {script.name}
                        </span>
                        {script.description && (
                          <span className="text-[8px] text-neutral-600 truncate">{script.description}</span>
                        )}
                      </div>
                      <Play size={9} className="shrink-0 opacity-0 group-hover:opacity-100 text-lime-400" />
                    </div>
                  ))
                )}
              </div>
            </>
          )}
        </div>

        {/* Editor + Console */}
        <div className="flex-1 flex flex-col min-w-0">
          {/* Code editor */}
          <div className="flex-1 min-h-0">
            <textarea
              className="w-full h-full bg-neutral-950 text-neutral-200 font-mono text-xs p-3 resize-none outline-none border-none"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              spellCheck={false}
              placeholder="Write your Lua script here..."
              onKeyDown={(e) => {
                // Ctrl+Enter to run
                if (e.ctrlKey && e.key === "Enter") {
                  e.preventDefault();
                  handleRun();
                }
                // Tab inserts 2 spaces
                if (e.key === "Tab") {
                  e.preventDefault();
                  const target = e.target as HTMLTextAreaElement;
                  const start = target.selectionStart;
                  const end = target.selectionEnd;
                  setCode(code.substring(0, start) + "  " + code.substring(end));
                  setTimeout(() => {
                    target.selectionStart = target.selectionEnd = start + 2;
                  }, 0);
                }
              }}
            />
          </div>

          {/* Console output */}
          <div className="h-40 bg-black border-t border-neutral-700 flex flex-col shrink-0">
            <div className="flex items-center justify-between px-2 py-0.5 bg-neutral-900 border-b border-neutral-800">
              <span className="text-[9px] text-neutral-500 uppercase">Console Output</span>
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={() => useDAWStore.getState().clearScriptConsole()}
                title="Clear Console"
              >
                <Trash2 size={9} />
              </Button>
            </div>
            <div className="flex-1 overflow-y-auto p-2 font-mono text-[10px]">
              {scriptConsoleOutput.map((line, i) => (
                <div
                  key={i}
                  className={`${
                    line.startsWith("Error") ? "text-red-400" : line.startsWith(">") ? "text-lime-400" : line.startsWith("---") ? "text-blue-400" : "text-neutral-400"
                  }`}
                >
                  {line}
                </div>
              ))}
              <div ref={consoleEndRef} />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
