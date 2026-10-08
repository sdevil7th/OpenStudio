import type { BuiltInPluginAddress, BuiltInPluginSchema } from "../../services/NativeBridge";

/** State/history operations shared by every built-in editor toolbar. */
export interface PluginEditorToolbarProps {
  historyReplayRevision?: number;
  onHostBypass?: (bypassed: boolean) => Promise<boolean>;
  schema: BuiltInPluginSchema;
  address: BuiltInPluginAddress;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  onApplyState: (state: string) => Promise<boolean>;
  onApplyValues: (values: Record<string, number>) => Promise<boolean>;
  onRecallPreset: (name: string) => Promise<boolean>;
  onFlush: () => Promise<boolean>;
}
