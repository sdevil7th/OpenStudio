// @ts-nocheck
/**
 * Custom action / macro management.
 * Extracted from useDAWStore.ts.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SetFn = (...args: any[]) => void;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type GetFn = () => any;

export const macroActions = (set: SetFn, get: GetFn) => ({
    addCustomAction: (name, steps, shortcut) => {
      set((s) => {
        const customActions = [
          ...s.customActions,
          { id: crypto.randomUUID(), name, steps, shortcut },
        ];
        localStorage.setItem("s13_customActions", JSON.stringify(customActions));
        return { customActions };
      });
    },
    removeCustomAction: (actionId) => {
      set((s) => {
        const customActions = s.customActions.filter((a) => a.id !== actionId);
        localStorage.setItem("s13_customActions", JSON.stringify(customActions));
        return { customActions };
      });
    },
    executeCustomAction: (actionId) => {
      const state = get();
      const macro = state.customActions.find((a) => a.id === actionId);
      if (!macro) return;
      // Use dynamic import to avoid circular dependency (actionRegistry imports useDAWStore)
      import("../actionRegistry").then(({ getRegisteredActions }) => {
        const actions = getRegisteredActions();
        for (const stepId of macro.steps) {
          const action = actions.find((a) => a.id === stepId);
          if (action) {
            action.execute();
          }
        }
      });
    },

});
