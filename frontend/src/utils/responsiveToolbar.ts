export type ResponsiveToolbarGroupId = string;

export interface ResponsiveToolbarGroup {
  id: ResponsiveToolbarGroupId;
  width: number;
  fixed?: boolean;
  overflowOrder?: number;
}

export interface ResponsiveToolbarLayoutOptions {
  availableWidth: number;
  groups: readonly ResponsiveToolbarGroup[];
  gap: number;
  moreButtonWidth: number;
}

export interface ResponsiveToolbarLayout {
  visibleIds: ResponsiveToolbarGroupId[];
  overflowIds: ResponsiveToolbarGroupId[];
  hasOverflow: boolean;
}

function totalWidth(
  groups: readonly ResponsiveToolbarGroup[],
  visibleIds: ReadonlySet<ResponsiveToolbarGroupId>,
  gap: number,
  moreButtonWidth: number,
  hasOverflow: boolean,
): number {
  const visibleGroups = groups.filter((group) => visibleIds.has(group.id));
  const itemCount = visibleGroups.length + (hasOverflow ? 1 : 0);
  const width = visibleGroups.reduce((sum, group) => sum + Math.max(0, group.width), 0)
    + (hasOverflow ? Math.max(0, moreButtonWidth) : 0);
  return width + Math.max(0, itemCount - 1) * Math.max(0, gap);
}

export function chooseResponsiveToolbarGroups({
  availableWidth,
  groups,
  gap,
  moreButtonWidth,
}: ResponsiveToolbarLayoutOptions): ResponsiveToolbarLayout {
  const usableWidth = Number.isFinite(availableWidth) ? Math.max(0, availableWidth) : Number.POSITIVE_INFINITY;
  const measuredGroups = groups.filter((group) => group.width > 0 || group.fixed);
  const visibleIds = new Set<ResponsiveToolbarGroupId>(measuredGroups.map((group) => group.id));

  if (totalWidth(measuredGroups, visibleIds, gap, moreButtonWidth, false) <= usableWidth) {
    return {
      visibleIds: measuredGroups.map((group) => group.id),
      overflowIds: [],
      hasOverflow: false,
    };
  }

  const overflowableGroups = measuredGroups
    .filter((group) => !group.fixed)
    .slice()
    .sort((a, b) => (a.overflowOrder ?? 0) - (b.overflowOrder ?? 0));

  for (const group of overflowableGroups) {
    visibleIds.delete(group.id);
    if (totalWidth(measuredGroups, visibleIds, gap, moreButtonWidth, true) <= usableWidth) {
      break;
    }
  }

  const visible = measuredGroups
    .filter((group) => visibleIds.has(group.id))
    .map((group) => group.id);
  const overflow = measuredGroups
    .filter((group) => !visibleIds.has(group.id))
    .map((group) => group.id);

  return {
    visibleIds: visible,
    overflowIds: overflow,
    hasOverflow: overflow.length > 0,
  };
}
