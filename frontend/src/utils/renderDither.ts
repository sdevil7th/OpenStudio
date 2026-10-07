export type DitherType = "none" | "tpdf" | "shaped" | "rpdf" | "shaped2";

export const ditherOptions = [
  { value: "tpdf", label: "TPDF (flat)" },
  { value: "shaped", label: "TPDF + 1st-order shaping" },
  { value: "shaped2", label: "TPDF + 2nd-order shaping" },
  { value: "rpdf", label: "RPDF (lower noise)" },
];

// An enabled older job with no mode selects the established TPDF default.
export const activeDitherType = (value: unknown): Exclude<DitherType, "none"> =>
  value === "shaped" || value === "shaped2" || value === "rpdf" ? value : "tpdf";
