// @ts-expect-error Vitest runs in Node; the WebView app omits Node builtin typings.
import { readFileSync } from "node:fs";
// @ts-expect-error Vitest runs in Node; the WebView app omits Node builtin typings.
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { nextNativeRequestId } from "../utils/nativeRequestId";

describe("injected native function transport", () => {
  it("correlates burst responses arriving out of order, including direct callers", async () => {
    const source=readFileSync(new URL("../../../Source/MainComponent.cpp", import.meta.url), "utf8");
    const script=[...source.matchAll(/withUserScript\(R"\(([\s\S]*?)\)"\)/g)].map(match=>match[1])
      .find(text=>text.includes("JUCE User Script: Initializing native functions"));
    if(!script)throw new Error("Native bootstrap script missing");
    const calls: {name:string;params:number[];resultId:number}[]=[];
    class Backend {
      listeners=new Map<number,(data:unknown)=>void>(); token=0;
      __openStudioLastNativeCallId=0;
      addEventListener(_event:string,fn:(data:unknown)=>void){const id=++this.token;this.listeners.set(id,fn);return id;}
      removeEventListener(id:number){this.listeners.delete(id);}
      emitEvent(_event:string,data:typeof calls[number]){calls.push(data);}
    }
    const backend=new Backend() as Backend & {echo:(value:number)=>Promise<number>};
    runInNewContext(script,{window:{__JUCE__:{backend,initialisationData:{__juce__functions:["echo"]}}},
      console:{log:()=>{}},Date:{now:()=>1791225000000},Math,setTimeout:()=>0,clearTimeout:()=>{}});
    const requests=Array.from({length:2000},(_,index)=>backend.echo(index));
    const directId=nextNativeRequestId(backend);
    expect(new Set(calls.map(call=>call.resultId)).size).toBe(calls.length);
    expect(calls.some(call=>call.resultId===directId)).toBe(false);
    for(const call of calls.reverse())for(const listener of [...backend.listeners.values()])listener({promiseId:call.resultId,result:call.params[0]});
    expect(await Promise.all(requests)).toEqual(Array.from({length:2000},(_,index)=>index));
    expect(backend.listeners.size).toBe(0);
  });
});
