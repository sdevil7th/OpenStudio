import type { ReactNode } from "react";

export type RackModuleId = "gate" | "pedal" | "amp" | "cab" | "eq" | "mod" | "delay" | "reverb";

export type NAMRackOversamplingFactor = 2 | 4 | 8;

export type RackSectionId = "pre" | "amp" | "cab" | "eq" | "post" | "browser" | "tuner" | "settings";

export const NAM_RACK_SECTIONS: Array<{
  id: RackSectionId;
  label: string;
  targetModule: RackModuleId;
}> = [
  { id: "pre", label: "Pre FX", targetModule: "pedal" },
  { id: "amp", label: "Amp", targetModule: "amp" },
  { id: "cab", label: "Cab", targetModule: "cab" },
  { id: "eq", label: "EQ", targetModule: "eq" },
  { id: "post", label: "Post FX", targetModule: "delay" },
];

export function isRackSectionId(value: unknown): value is RackSectionId {
  return (
    value === "pre"
    || value === "amp"
    || value === "cab"
    || value === "eq"
    || value === "post"
    || value === "browser"
    || value === "tuner"
    || value === "settings"
  );
}

export function rackSectionForModule(moduleId: RackModuleId): RackSectionId {
  if (moduleId === "gate" || moduleId === "pedal") return "pre";
  if (moduleId === "amp") return "amp";
  if (moduleId === "cab") return "cab";
  if (moduleId === "eq") return "eq";
  if (moduleId === "mod" || moduleId === "delay" || moduleId === "reverb") return "post";
  return "pre";
}

export type NAMSignalChainRouteModule = {
  id: string;
  label: string;
  caption: string;
  status?: string;
  enabled?: boolean;
  icon?: ReactNode;
  disabled?: boolean;
  onToggle?: () => void;
  onEdit?: () => void;
  editLabel?: string;
};

export type NAMSignalChainPostModule = Omit<
  NAMSignalChainRouteModule,
  "enabled" | "onToggle" | "onEdit"
> & {
  enabled: boolean;
  onToggle: () => void;
  onEdit: () => void;
  canMoveLeft: boolean;
  canMoveRight: boolean;
  onMoveLeft: () => void;
  onMoveRight: () => void;
};
