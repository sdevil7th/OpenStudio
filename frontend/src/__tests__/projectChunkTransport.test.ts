import { afterEach, describe, expect, it, vi } from "vitest";
import { nativeBridge } from "../services/NativeBridge";
const nativeFlag=Object.getOwnPropertyDescriptor(nativeBridge,"isNative")!;
afterEach(()=>{Object.defineProperty(nativeBridge,"isNative",nativeFlag);vi.unstubAllGlobals();});
function host(backend:object){Object.defineProperty(nativeBridge,"isNative",{value:true,configurable:true});vi.stubGlobal("window",{__JUCE__:{backend}});}
describe("project chunk transport",()=>{
  it("keeps overlapping reads separate until the previous native snapshot is released",async()=>{
    let unblock!:()=>void;
    const barrier=new Promise<void>(resolve=>{unblock=resolve;});
    const events:string[]=[];
    const begin=vi.fn(async(path:string)=>{events.push(`begin:${path}`);return {token:path,length:2};});
    host({beginProjectFileRead:begin,readProjectFileChunk:vi.fn(async(token:string)=>{
      if(token==="first")await barrier;
      return {data:"{}",nextOffset:2};
    }),releaseProjectFileRead:vi.fn(async(token:string)=>{events.push(`release:${token}`);return true;})});
    const first=nativeBridge.loadProjectFromFile("first"),second=nativeBridge.loadProjectFromFile("second");
    await Promise.resolve();await Promise.resolve();
    expect(begin).toHaveBeenCalledTimes(1);
    unblock();expect(await first).toBe("{}");expect(await second).toBe("{}");
    expect(events).toEqual(["begin:first","release:first","begin:second","release:second"]);
  });
  it("reports native file errors and permits a later read after failure",async()=>{
    const begin=vi.fn().mockResolvedValueOnce({error:"Project file could not be opened: sharing violation"})
      .mockResolvedValueOnce({token:"ok",length:2});
    host({beginProjectFileRead:begin,readProjectFileChunk:vi.fn().mockResolvedValue({data:"{}",nextOffset:2}),releaseProjectFileRead:vi.fn().mockResolvedValue(true)});
    await expect(nativeBridge.loadProjectFromFile("first")).rejects.toThrow("sharing violation");
    expect(await nativeBridge.loadProjectFromFile("second")).toBe("{}");
  });
  it("joins large saved state and advances by native character cursors, including emoji",async()=>{
    const fragments=['{"name":"😀","state":"',...Array.from({length:90},()=>"x".repeat(8192)),'"}'];
    const offsets=[0];for(const text of fragments)offsets.push(offsets[offsets.length-1]+Array.from(text).length);
    const release=vi.fn().mockResolvedValue(true);
    const read=vi.fn(async(_token:string,offset:number)=>{const index=offsets.indexOf(offset);return {data:fragments[index],nextOffset:offsets[index+1]};});
    host({beginProjectFileRead:vi.fn().mockResolvedValue({token:"snapshot",length:offsets[offsets.length-1]}),readProjectFileChunk:read,releaseProjectFileRead:release});
    expect(JSON.parse(await nativeBridge.loadProjectFromFile("C:/session.osproj"))).toEqual({name:"😀",state:"x".repeat(90*8192)});
    expect(read.mock.calls.map(call=>call[1])).toEqual(offsets.slice(0,-1));
    expect(release).toHaveBeenCalledWith("snapshot");
  });
  it("rejects a non-advancing cursor and releases the snapshot on failure",async()=>{
    const release=vi.fn().mockResolvedValue(true);
    host({beginProjectFileRead:vi.fn().mockResolvedValue({token:"snapshot",length:20}),readProjectFileChunk:vi.fn().mockResolvedValue({data:"x",nextOffset:0}),releaseProjectFileRead:release});
    await expect(nativeBridge.loadProjectFromFile("C:/session.osproj")).rejects.toThrow("Incomplete project read");
    expect(release).toHaveBeenCalledWith("snapshot");
  });
  it("retains the legacy bridge contract when chunk functions are unavailable",async()=>{
    const read=vi.fn().mockResolvedValue('{"tracks":[]}');host({loadProjectFromFile:read});
    expect(await nativeBridge.loadProjectFromFile("C:/legacy.osproj")).toBe('{"tracks":[]}');
    expect(read).toHaveBeenCalledWith("C:/legacy.osproj");
  });
});
