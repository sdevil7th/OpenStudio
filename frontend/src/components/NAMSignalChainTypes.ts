import type { ReactNode } from "react";

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
