export type NAMRackCabMode = "empty" | "required" | "loaded" | "embedded";

export type NAMRackCabRecommendedAction =
  | "browse-amp-captures"
  | "choose-ir"
  | "replace-ir"
  | "browse-amp-only-captures";

export type NAMRackCabPresentationInput = {
  hasAmpCapture: boolean;
  hasCabIR: boolean;
  embeddedCabCapture: boolean;
};

export type NAMRackCabPresentation = {
  mode: NAMRackCabMode;
  label: string;
  status: string;
  recommendedAction: NAMRackCabRecommendedAction;
  recommendedActionLabel: string;
  needsCabIR: boolean;
  hasRetainedExternalIR: boolean;
  canBrowseExternalIR: boolean;
  canLoadLocalIR: boolean;
  canClearExternalIR: boolean;
  canToggleExternalCab: boolean;
};

/**
 * Resolves the user-facing cabinet state independently of any particular rack
 * surface. An embedded/full-rig cabinet always wins over a retained external
 * IR, which may remain loaded so it can be restored after switching captures.
 */
export function resolveNAMRackCabPresentation({
  hasAmpCapture,
  hasCabIR,
  embeddedCabCapture,
}: NAMRackCabPresentationInput): NAMRackCabPresentation {
  if (embeddedCabCapture) {
    return {
      mode: "embedded",
      label: "Cab included in amp capture",
      status: "The full-rig capture already includes its cabinet.",
      recommendedAction: "browse-amp-only-captures",
      recommendedActionLabel: "Browse amp-only captures",
      needsCabIR: false,
      hasRetainedExternalIR: hasCabIR,
      canBrowseExternalIR: false,
      canLoadLocalIR: false,
      canClearExternalIR: false,
      canToggleExternalCab: false,
    };
  }

  if (hasCabIR) {
    return {
      mode: "loaded",
      label: "Cabinet IR loaded",
      status: "External cabinet IR configured.",
      recommendedAction: "replace-ir",
      recommendedActionLabel: "Replace IR",
      needsCabIR: false,
      hasRetainedExternalIR: false,
      canBrowseExternalIR: true,
      canLoadLocalIR: true,
      canClearExternalIR: true,
      canToggleExternalCab: true,
    };
  }

  if (hasAmpCapture) {
    return {
      mode: "required",
      label: "No cabinet IR loaded",
      status: "This amp capture needs a cabinet IR.",
      recommendedAction: "choose-ir",
      recommendedActionLabel: "Choose IR",
      needsCabIR: true,
      hasRetainedExternalIR: false,
      canBrowseExternalIR: true,
      canLoadLocalIR: true,
      canClearExternalIR: false,
      canToggleExternalCab: false,
    };
  }

  return {
    mode: "empty",
    label: "No cabinet IR loaded",
    status: "No amp capture or cabinet IR is loaded.",
    recommendedAction: "browse-amp-captures",
    recommendedActionLabel: "Browse amp captures",
    needsCabIR: false,
    hasRetainedExternalIR: false,
    canBrowseExternalIR: true,
    canLoadLocalIR: true,
    canClearExternalIR: false,
    canToggleExternalCab: false,
  };
}
