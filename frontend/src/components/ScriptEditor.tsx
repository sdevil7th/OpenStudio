import { useState, useRef, useEffect } from "react";
import { X, Play, Trash2, Plus, Save } from "lucide-react";
import { useDAWStore } from "../store/useDAWStore";
import { Button } from "./ui";

export function ScriptEditor() {
  const showScriptEditor = useDAWStore((s) => s.showScriptEditor);
  const scriptConsoleOutput = useDAWStore((s) => s.scriptConsoleOutput);
  const userScripts = useDAWStore((s) => s.userScripts);

  const [code, setCode] = useState("// Studio13 Script\n// Available: studio.getTracks(), studio.play(), studio.stop()\n\nconsole.log('Hello from Studio13!');\n");
  const [selectedScriptId, setSelectedScriptId] = useState<string | null>(null);
  const [isRunning, setIsRunning] = useState(false);
  const consoleEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    consoleEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [scriptConsoleOutput]);

  const handleRun = async () => {
    setIsRunning(true);
    useDAWStore.getState().appendScriptConsole(`--- Running script ---`);
    await useDAWStore.getState().executeScript(code);
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
    }
  };

  if (!showScriptEditor) return null;

  return (
    <div className="fixed inset-8 z-2000 bg-neutral-900 border border-neutral-700 rounded-lg shadow-2xl flex flex-col overflow-hidden">
      {/* Header */}
      <div className="h-7 bg-neutral-800 border-b border-neutral-700 flex items-center justify-between px-3 shrink-0">
        <span className="text-[10px] font-semibold text-neutral-300 uppercase tracking-wider">
          Script Editor
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
        <div className="w-48 bg-neutral-850 border-r border-neutral-700 flex flex-col shrink-0">
          <div className="flex items-center justify-between px-2 py-1 border-b border-neutral-700">
            <span className="text-[9px] text-neutral-500 uppercase">Scripts</span>
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
                  className={`flex items-center justify-between px-2 py-1 cursor-pointer hover:bg-neutral-800 text-[10px] ${
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
              placeholder="Write your script here..."
            />
          </div>

          {/* Console output */}
          <div className="h-40 bg-black border-t border-neutral-700 flex flex-col shrink-0">
            <div className="flex items-center justify-between px-2 py-0.5 bg-neutral-900 border-b border-neutral-800">
              <span className="text-[9px] text-neutral-500 uppercase">Console</span>
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
                    line.startsWith("Error") ? "text-red-400" : line.startsWith(">") ? "text-green-400" : "text-neutral-400"
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
