import { describe, expect, it } from "vitest";
import { positionNAMRackTooltip } from "../components/NAMRackControlTooltip";

const viewport = { top: 0, left: 0, width: 800, height: 600 };
const tooltip = { width: 120, height: 48 };

describe("NAM rack control tooltip placement", () => {
  it("prefers above a control when there is room", () => {
    expect(positionNAMRackTooltip(
      { top: 300, right: 440, bottom: 340, left: 400, width: 40, height: 40 },
      tooltip,
      viewport,
    )).toEqual({ left: 360, top: 242, placement: "above" });
  });

  it("flips below controls near the top of the viewport", () => {
    expect(positionNAMRackTooltip(
      { top: 12, right: 440, bottom: 52, left: 400, width: 40, height: 40 },
      tooltip,
      viewport,
    )).toEqual({ left: 360, top: 62, placement: "below" });
  });

  it("keeps the tooltip inside both horizontal viewport edges", () => {
    const atLeft = positionNAMRackTooltip(
      { top: 300, right: 30, bottom: 340, left: -10, width: 40, height: 40 },
      tooltip,
      viewport,
    );
    const atRight = positionNAMRackTooltip(
      { top: 300, right: 810, bottom: 340, left: 770, width: 40, height: 40 },
      tooltip,
      viewport,
    );

    expect(atLeft.left).toBe(8);
    expect(atRight.left).toBe(672);
  });

  it("honours an offset visual viewport and clamps oversized vertical placement", () => {
    expect(positionNAMRackTooltip(
      { top: 115, right: 160, bottom: 145, left: 130, width: 30, height: 30 },
      { width: 130, height: 190 },
      { top: 100, left: 50, width: 300, height: 200 },
    )).toEqual({ left: 80, top: 108, placement: "below" });
  });
});
