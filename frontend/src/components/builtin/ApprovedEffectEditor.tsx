import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import type { BuiltInParamDescriptor, BuiltInPluginSchema, GainPhaseAlignmentEntry, GainPhaseAlignmentResult } from "../../services/NativeBridge";
import { findBuiltInParameter } from "../../utils/builtInExpandedSelectors";
import type { PluginEditorToolbarProps } from "./PluginEditorContracts";
import { SuiteParameter, type ParameterChange } from "./SuiteParameter";
import { nativeBridge } from "../../services/NativeBridge";
import { useStableMeterSnapshot } from "./useStableMeterSnapshot";
import { ProfiledRangeInput } from "../ui";
import { formatParamValue } from "../../utils/builtInParamValue";

export type ApprovedEffectEditorProps = PluginEditorToolbarProps & {
  onApplyAlignment?: (entries: GainPhaseAlignmentEntry[]) => Promise<GainPhaseAlignmentResult>;
  onChange: ParameterChange;
  onGestureStart: (id: string) => void;
  onGestureEnd: () => void;
};

type EffectMeters = BuiltInPluginSchema["visualization"];
type EffectMeterReceipt = { meters: EffectMeters; receivedAt: number; sequence: number };
export function useApprovedEffectMeters({ schema, address }: Pick<ApprovedEffectEditorProps, "schema" | "address">, onReceive?: (meters: EffectMeters) => void) {
  const [meters, publish] = useStableMeterSnapshot();
  const [queried, setQueried] = useState(false);
  const received = useRef(onReceive); received.current = onReceive;
  useEffect(() => {
    publish(null);
    setQueried(false);
    received.current?.(undefined);
    let retired = false, pending = false;
    const poll = () => {
      if (retired || pending || document.hidden) return;
      pending = true;
      void nativeBridge.getBuiltInPluginMeters(address)
        .then(next => { if (!retired) { publish(next); setQueried(true); received.current?.(next ?? undefined); } })
        .catch(() => { if (!retired) { publish(null); setQueried(true); received.current?.(undefined); } })
        .finally(() => { pending = false; });
    };
    poll();
    const timer = window.setInterval(poll, 50);
    return () => { retired = true; window.clearInterval(timer); };
  }, [address.trackId, address.chain, address.fxIndex, address.instanceId, publish]);
  return queried ? meters ?? undefined : schema.visualization;
}

const EffectMeterContext = createContext<EffectMeters>(undefined);
const EffectMeterReceiptContext = createContext<EffectMeterReceipt>({ meters: undefined, receivedAt: 0, sequence: 0 });
/** Only subscribed meter leaves update at telemetry rate; parameter controls stay outside that state. */
export function EffectMeterProvider({ children, ...props }: Pick<ApprovedEffectEditorProps, "schema" | "address"> & { children: ReactNode }) {
  const [receipt, setReceipt] = useState<EffectMeterReceipt>({ meters: undefined, receivedAt: 0, sequence: 0 });
  const meters = useApprovedEffectMeters(props, next => setReceipt(previous => ({ meters: next, receivedAt: next ? performance.now() : 0, sequence: previous.sequence + 1 })));
  return <EffectMeterReceiptContext.Provider value={receipt}><EffectMeterContext.Provider value={meters}>{children}</EffectMeterContext.Provider></EffectMeterReceiptContext.Provider>;
}
export const useEffectMeterSnapshot = () => useContext(EffectMeterContext);
export const useReceivedEffectMeters = () => useContext(EffectMeterReceiptContext);

/** Resolve appended automation aliases and keep all gestures in the native editor's history. */
export function createEffectParameterRenderer(props: ApprovedEffectEditorProps, schema: BuiltInPluginSchema = props.schema) {
  return (id: string, large = false, label?: string): ReactNode => {
    const parameter = findBuiltInParameter(schema, id);
    return parameter ? <SuiteParameter key={parameter.id} parameter={parameter} label={label} large={large}
      onChange={props.onChange} onGestureStart={props.onGestureStart} onGestureEnd={props.onGestureEnd} /> : null;
  };
}

export function EffectModeSwitch({ parameter, onChange, onGestureStart, onGestureEnd, label, descriptions }: {
  parameter?: BuiltInParamDescriptor;
  onChange: ParameterChange;
  onGestureStart: (id: string) => void;
  onGestureEnd: () => void;
  label: string;
  descriptions?: Record<number, string>;
}) {
  if (!parameter || parameter.type !== "enum") return null;
  return <div className="effect-mode-switch flex gap-1" role="group" aria-label={label}>
    {parameter.enumOptions?.map(option => <button key={option.value} type="button" aria-pressed={Math.round(parameter.value) === option.value}
      data-param={parameter.id} title={descriptions?.[option.value]} onClick={() => {
        if (parameter.value === option.value) return;
        onGestureStart(parameter.id);
        try { onChange(parameter, option.value); } finally { onGestureEnd(); }
      }}><i aria-hidden="true" /><strong>{option.label}</strong>{descriptions?.[option.value] && <small>{descriptions[option.value]}</small>}</button>)}
  </div>;
}

export function EffectRange({ parameter, label, ...props }: Pick<ApprovedEffectEditorProps, "onChange" | "onGestureStart" | "onGestureEnd"> & {
  parameter?: BuiltInParamDescriptor; label: string;
}) {
  if (!parameter) return null;
  const percent = parameter.type === "continuous" && parameter.min === 0 && parameter.max <= 1 && !parameter.unit;
  return <label className="effect-range flex min-w-0 flex-col gap-2 text-xs" data-param={parameter.id}>
    <span className="flex justify-between gap-3"><span>{label}</span><output>{percent ? `${Math.round(parameter.value * 100)}%` : formatParamValue(parameter)}</output></span>
    <ProfiledRangeInput aria-label={label} min={parameter.min} max={parameter.max} step={(parameter.max - parameter.min) / 1000}
      value={parameter.value} onValueChange={value => props.onChange(parameter, value)}
      onBeginEdit={() => props.onGestureStart(parameter.id)} onCommitEdit={props.onGestureEnd} />
  </label>;
}
