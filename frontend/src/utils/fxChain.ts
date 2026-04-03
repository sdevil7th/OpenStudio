import { nativeBridge } from "../services/NativeBridge";

export type FXChainType = "input" | "track" | "master";
export interface FXChainChangeDetail {
  trackId: string;
  chainType: FXChainType;
}

export interface InstrumentChangeDetail {
  trackId: string;
  instrumentPlugin?: string | null;
}

const FX_CHAIN_CHANGED_EVENT = "studio13:fx-chain-changed";
const INSTRUMENT_CHANGED_EVENT = "studio13:instrument-changed";

export async function getFXChainSlots(trackId: string, chainType: FXChainType): Promise<any[]> {
  if (chainType === "master") {
    return await nativeBridge.getMasterFX();
  }

  if (chainType === "input") {
    return await nativeBridge.getTrackInputFX(trackId);
  }

  return await nativeBridge.getTrackFX(trackId);
}

export async function waitForFXChainLength(
  trackId: string,
  chainType: FXChainType,
  minimumLength: number,
  options?: { attempts?: number; delayMs?: number },
): Promise<any[]> {
  const attempts = options?.attempts ?? 10;
  const delayMs = options?.delayMs ?? 50;

  let latest = await getFXChainSlots(trackId, chainType);
  if (latest.length >= minimumLength) {
    return latest;
  }

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    latest = await getFXChainSlots(trackId, chainType);
    if (latest.length >= minimumLength) {
      return latest;
    }
  }

  return latest;
}

function dispatchFrontendEvent<T>(eventName: string, detail: T) {
  if (typeof window === "undefined") {
    return;
  }

  window.dispatchEvent(new CustomEvent<T>(eventName, { detail }));
}

function subscribeToFrontendEvent<T>(
  eventName: string,
  callback: (detail: T) => void,
): () => void {
  if (typeof window === "undefined") {
    return () => {};
  }

  const handler = (event: Event) => {
    callback((event as CustomEvent<T>).detail);
  };

  window.addEventListener(eventName, handler as EventListener);
  return () => {
    window.removeEventListener(eventName, handler as EventListener);
  };
}

export function notifyFXChainChanged(detail: FXChainChangeDetail) {
  dispatchFrontendEvent(FX_CHAIN_CHANGED_EVENT, detail);
}

export function subscribeToFXChainChanged(
  callback: (detail: FXChainChangeDetail) => void,
): () => void {
  return subscribeToFrontendEvent(FX_CHAIN_CHANGED_EVENT, callback);
}

export function notifyInstrumentChanged(detail: InstrumentChangeDetail) {
  dispatchFrontendEvent(INSTRUMENT_CHANGED_EVENT, detail);
}

export function subscribeToInstrumentChanged(
  callback: (detail: InstrumentChangeDetail) => void,
): () => void {
  return subscribeToFrontendEvent(INSTRUMENT_CHANGED_EVENT, callback);
}

export async function waitForInstrumentPlugin(
  trackId: string,
  expectedPlugin: string,
  readInstrumentPlugin: (trackId: string) => string | null | undefined | Promise<string | null | undefined>,
  options?: { attempts?: number; delayMs?: number },
): Promise<string | null | undefined> {
  const attempts = options?.attempts ?? 10;
  const delayMs = options?.delayMs ?? 50;

  let latest = await readInstrumentPlugin(trackId);
  if (latest === expectedPlugin) {
    return latest;
  }

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    latest = await readInstrumentPlugin(trackId);
    if (latest === expectedPlugin) {
      return latest;
    }
  }

  return latest;
}
