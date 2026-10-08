import { VOLUME_DB_RANGE, VOLUME_MIN_DB } from "../store/automationParams";
import { envelopeValue, type EnvelopePoint } from "./automationEnvelopeEdits";

export function normalizeTrimDB(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(-60, Math.min(12, value)) : 0;
}

/** Bound the product of linear send level and dB Trim to 0.00001 gain error. */
export function freezeSendTrimEnvelope(base: readonly EnvelopePoint[], trim: readonly EnvelopePoint[], manualDB: number): EnvelopePoint[] {
  if (!base.length) throw new Error("Freeze Trim needs an existing send level envelope with Read enabled.");
  const valueAt = (time: number) => {
    const offset = trim.length ? envelopeValue(trim, time) * VOLUME_DB_RANGE + VOLUME_MIN_DB : normalizeTrimDB(manualDB);
    const value = envelopeValue(base, time) * Math.pow(10, offset / 20);
    if (value < 0 || value > 1 + 1e-7) throw new Error("The combined send curve exceeds its level range. Keep the separate Trim curve.");
    return Math.min(1, value);
  };
  const times = [...new Set([...base, ...trim].map(point => point.time))].sort((a,b) => a-b);
  const output: EnvelopePoint[] = [{time:times[0],value:valueAt(times[0])}];
  const append = (start: number, end: number, left: number, right: number, depth: number) => {
    const error = [.25,.5,.75].some(fraction => Math.abs(valueAt(start+(end-start)*fraction) - (left+(right-left)*fraction)) > .00001);
    if (error) {
      if (depth >= 16 || output.length >= 4095) throw new Error("The combined send curve needs too many points. Keep the separate Trim curve.");
      const middle=(start+end)/2, value=valueAt(middle);
      append(start,middle,left,value,depth+1);append(middle,end,value,right,depth+1);
    } else output.push({time:end,value:right});
  };
  for(let i=1;i<times.length;i++) {
    const start=times[i-1],end=times[i],left=envelopeValue(base,start),right=envelopeValue(base,end);
    // A linear gain times an exponential can peak between all probe points.
    // Check its analytic stationary point before approximating the curve.
    const exponent=trim.length ? (envelopeValue(trim,end)-envelopeValue(trim,start))*VOLUME_DB_RANGE*Math.LN10/20 : 0;
    const slope=right-left;
    if(slope && exponent) {
      const fraction=-(slope+exponent*left)/(exponent*slope);
      if(fraction>0 && fraction<1)valueAt(start+(end-start)*fraction);
    }
    append(start,end,valueAt(start),valueAt(end),0);
  }
  if(output.length>4096)throw new Error("The combined send curve exceeds the point limit. Keep the separate Trim curve.");
  return output;
}

/** Sum the two dB-linear curves without changing the audible range or mute. */
export function freezeTrimEnvelope(base: readonly EnvelopePoint[], trim: readonly EnvelopePoint[], manualDB = 0): EnvelopePoint[] {
  if (!base.length) throw new Error("Freeze Trim requires an existing volume envelope with Read enabled.");
  const times = [...new Set([...base, ...trim].map(point => point.time))].sort((a, b) => a - b);
  return times.map(time => {
    const volume = envelopeValue(base, time);
    const offset = trim.length ? envelopeValue(trim, time) * VOLUME_DB_RANGE + VOLUME_MIN_DB : normalizeTrimDB(manualDB);
    if (volume <= 0 && Math.abs(offset) > 1e-7) throw new Error("Freeze Trim cannot combine an offset at a muted volume point. Keep the separate Trim curve.");
    const value = volume + offset / VOLUME_DB_RANGE;
    if (value < -1e-7 || value > 1 + 1e-7) throw new Error("The combined curve exceeds the volume range. Keep the separate Trim curve.");
    return { time, value: Math.max(0, Math.min(1, value)) };
  });
}
