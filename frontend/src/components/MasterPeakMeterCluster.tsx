import { useCallback, useState } from "react";
import { PeakMeter } from "./PeakMeter";
import {
  MASTER_DBFS_RULING_MARKS,
  MASTER_DBFS_OVERLAY_WIDTH_PX,
  MASTER_EXTENDED_METER_WIDTH_PX,
  MASTER_METER_CLUSTER_WIDTH_PX,
  normalizeDbToMeter,
} from "./meterConfig";

interface MasterPeakMeterClusterProps {
  level: number;
  clipping: boolean;
  onReset?: () => void;
}

export function MasterPeakMeterCluster({
  level,
  clipping,
  onReset,
}: MasterPeakMeterClusterProps) {
  const [resetSignal, setResetSignal] = useState(0);

  const handleReset = useCallback(() => {
    setResetSignal((value) => value + 1);
    onReset?.();
  }, [onReset]);

  const getLabelPosition = useCallback((markDb: number) => {
    const normalized = normalizeDbToMeter(markDb, "dbfs");
    const percent = (1 - normalized) * 100;

    if (markDb === 0) {
      return { top: "6px", transform: "translateX(-50%)" };
    }

    if (markDb === -60) {
      return { top: "calc(100% - 7px)", transform: "translate(-50%, -100%)" };
    }

    return { top: `${percent}%`, transform: "translate(-50%, -50%)" };
  }, []);

  return (
    <div
      className="relative shrink-0 h-full"
      style={{ width: `${MASTER_METER_CLUSTER_WIDTH_PX}px` }}
      onClick={handleReset}
    >
      <PeakMeter
        level={level}
        stereo={true}
        clipping={clipping}
        scaleMode="extended"
        showThresholdLine={true}
        width={MASTER_EXTENDED_METER_WIDTH_PX}
        resetSignal={resetSignal}
      />
      <div className="absolute inset-y-px left-1/2 -translate-x-1/2 pointer-events-none">
        <PeakMeter
          level={level}
          stereo={true}
          clipping={clipping}
          scaleMode="dbfs"
          showRulings={false}
          showRulingLabels={false}
          showRulingLines={false}
          width={MASTER_DBFS_OVERLAY_WIDTH_PX}
          resetSignal={resetSignal}
          showBorder={false}
          renderMode="continuous"
          showCenterDivider={false}
          colorScheme="centerContrast"
        />
        <div className="absolute inset-0 pointer-events-none">
          {MASTER_DBFS_RULING_MARKS.filter((markDb) => markDb !== 0).map((markDb) => (
            <span
              key={markDb}
              className="absolute left-1/2 text-[10px] font-semibold leading-none tracking-[-0.02em] text-black/50"
              style={{ ...getLabelPosition(markDb), mixBlendMode: "multiply" }}
            >
              {markDb > 0 ? `+${markDb}` : `${markDb}`}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}
