import { X, Plus } from "lucide-react";
import { useDAWStore } from "../store/useDAWStore";
import { useShallow } from "zustand/shallow";
import { useContextMenu } from "./ContextMenu";

export function ProjectTabBar() {
  const { projectTabs, activeTabId } = useDAWStore(useShallow((s) => ({
    projectTabs: s.projectTabs,
    activeTabId: s.activeTabId,
  })));
  const { showContextMenu, ContextMenuComponent } = useContextMenu();

  if (projectTabs.length <= 1) return null; // Hide when single tab

  const handleContextMenu = (e: React.MouseEvent, tabId: string) => {
    showContextMenu(e, [
      {
        label: "Close Tab",
        onClick: () => useDAWStore.getState().closeProjectTab(tabId),
        disabled: projectTabs.length <= 1,
      },
      {
        label: "Close Other Tabs",
        onClick: () => {
          projectTabs
            .filter((t) => t.id !== tabId)
            .forEach((t) => useDAWStore.getState().closeProjectTab(t.id));
        },
        disabled: projectTabs.length <= 1,
      },
      { divider: true, label: "" },
      {
        label: "New Tab",
        onClick: () => useDAWStore.getState().addProjectTab(),
      },
    ]);
  };

  return (
    <>
      <div className="h-6 bg-neutral-900 border-b border-neutral-700 flex items-center px-1 shrink-0 overflow-x-auto">
        {projectTabs.map((tab) => (
          <div
            key={tab.id}
            className={`flex items-center gap-1 px-2 py-0.5 text-[10px] cursor-pointer border-r border-neutral-800 shrink-0 max-w-[160px] ${
              tab.id === activeTabId
                ? "bg-neutral-800 text-white border-b-2 border-b-blue-500"
                : "text-neutral-500 hover:bg-neutral-850 hover:text-neutral-300"
            }`}
            onClick={() => useDAWStore.getState().switchProjectTab(tab.id)}
            onContextMenu={(e) => handleContextMenu(e, tab.id)}
          >
            <span className="truncate">{tab.name}</span>
            {projectTabs.length > 1 && (
              <button
                className="shrink-0 p-0.5 rounded hover:bg-neutral-700 opacity-0 hover:opacity-100 transition-opacity"
                onClick={(e) => {
                  e.stopPropagation();
                  useDAWStore.getState().closeProjectTab(tab.id);
                }}
              >
                <X size={8} />
              </button>
            )}
          </div>
        ))}
        <button
          className="px-1.5 py-0.5 text-neutral-600 hover:text-neutral-300 hover:bg-neutral-800 rounded transition-colors shrink-0"
          onClick={() => useDAWStore.getState().addProjectTab()}
          title="New Tab"
        >
          <Plus size={11} />
        </button>
      </div>
      {ContextMenuComponent}
    </>
  );
}
