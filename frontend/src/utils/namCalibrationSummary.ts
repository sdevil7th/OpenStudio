export type NAMCalibrationSummaryStatus = "complete" | "partial" | "override" | "off" | "unavailable";

export function summarizeNAMCalibrationStatuses(statuses: readonly NAMCalibrationSummaryStatus[]) {
  if (statuses.length === 0) {
    return { status: "unavailable" as const, label: "No data", readyCount: 0 };
  }

  const readyCount = statuses.filter((status) => status === "complete" || status === "override").length;
  if (readyCount > 0 && readyCount < statuses.length) {
    return {
      status: "partial" as const,
      label: `${readyCount}/${statuses.length} ready`,
      readyCount,
    };
  }

  if (readyCount === statuses.length) {
    const allOverrides = statuses.every((status) => status === "override");
    const mixedReadyModes = !allOverrides && statuses.some((status) => status === "override");
    return {
      status: allOverrides ? "override" as const : "complete" as const,
      label: allOverrides ? "Override" : mixedReadyModes ? "Ready" : "Model",
      readyCount,
    };
  }

  const problemStatuses = new Set(statuses);
  if (problemStatuses.size > 1) {
    return { status: "partial" as const, label: "Check", readyCount };
  }

  const status = statuses[0];
  return {
    status,
    label: status === "partial" ? "Partial" : status === "off" ? "Off" : "No data",
    readyCount,
  };
}
