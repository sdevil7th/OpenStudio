import type { InputHTMLAttributes } from "react";
import type { WheelSubtarget } from "../../../utils/wheelGestureResolver";

export interface ProfiledRangeInputProps extends Omit<
  InputHTMLAttributes<HTMLInputElement>,
  "type" | "min" | "max" | "step" | "value" | "defaultValue" | "onChange"
> {
  min: number;
  max: number;
  step?: number;
  value: number;
  onValueChange: (value: number) => void;
  onBeginEdit?: () => void;
  onCommitEdit?: () => void;
  wheelSubtarget?: WheelSubtarget;
}
