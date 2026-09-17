import { afterEach, describe, expect, it, vi } from "vitest";
import { createBackgroundResponse, createContentMessage, createRequestMessage, validateBackgroundResponse, validateGlossPortOutbound } from "../../src/shared/messages";
import { sendRuntimeRequest } from "../../src/shared/runtimeClient";
import { DEFAULT_SETTINGS, type GlossOutcome } from "../../src/shared/types";

afterEach(()=> { vi.unstubAllGlobals(); vi.useRealTimers(); });
describe("runtime request contract",()=> {
  it("rejects an unrelated valid response and malformed outcome variants",()=> {
    const request=createContentMessage("settings.get",{});
    const response={...createBackgroundResponse(request,"settings.response",{settings:DEFAULT_SETTINGS}),type:"word.clicked.ok",payload:{noteId:42}};
    expect(()=>validateBackgroundResponse(response,request)).toThrow("Unexpected response type");
    for (const payload of [{scanId:"s",tokenId:"t",status:"ready"},{scanId:"s",tokenId:"t",status:"error"}]) expect(()=>validateGlossPortOutbound({type:"gloss.token",version:1,createdAt:0,payload})).toThrow();
  });
  it("settles only once and ignores a callback after its local timeout",async()=> {
    vi.useFakeTimers();
    let callback: (value:unknown)=>void = ()=>{};
    vi.stubGlobal("chrome",{runtime:{sendMessage:(_request:unknown,cb:typeof callback)=>{callback=cb;}}});
    const request=createContentMessage("settings.get",{});
    const pending=sendRuntimeRequest(request,{timeoutMs:10});
    const assertion=expect(pending).rejects.toMatchObject({payload:{reason:"timeout",service:"runtime"}});
    await vi.advanceTimersByTimeAsync(10);
    await assertion;
    callback(createBackgroundResponse(request,"settings.response",{settings:DEFAULT_SETTINGS}));
    expect(vi.getTimerCount()).toBe(0);
  });
  it("returns a valid business error and rejects callback transport errors",async()=> {
    const request=createContentMessage("settings.get",{});
    const business=createBackgroundResponse(request,"error",{reason:"runtime",message:"storage unavailable"});
    vi.stubGlobal("chrome",{runtime:{sendMessage:(_request:unknown,cb:(value:unknown)=>void)=>cb(business)}});
    await expect(sendRuntimeRequest(request,{timeoutMs:null})).resolves.toEqual(business);
    vi.stubGlobal("chrome",{runtime:{lastError:{message:"receiver unavailable"},sendMessage:(_request:unknown,cb:(value:unknown)=>void)=>cb(undefined)}});
    await expect(sendRuntimeRequest(request)).rejects.toMatchObject({payload:{reason:"runtime",message:"receiver unavailable"}});
  });
});

// These contracts are typechecked with the test project; no runtime invalid objects are constructed.
function compileTimeContracts(): void {
  const request=createContentMessage("settings.get",{});
  // @ts-expect-error A successful response must belong to this request.
  createBackgroundResponse(request,"word.clicked.ok",{noteId:42});
  // @ts-expect-error The required success payload cannot be supplied through another response variant.
  createBackgroundResponse(request,"settings.response",{noteId:42});
  // @ts-expect-error Ready outcomes require their item.
  const ready: GlossOutcome={status:"ready"};
  // @ts-expect-error Error outcomes require their diagnostic.
  const error: GlossOutcome={status:"error"};
  // @ts-expect-error Popup cannot mutate known vocabulary.
  createRequestMessage("popup","known.words.clear",{});
  void [ready,error];
}
void compileTimeContracts;

describe("runtime response delivery modes",()=> {
  it("accepts Promise-only delivery and ignores a second delivery",async()=> {
    const request=createContentMessage("settings.get",{});
    const success=createBackgroundResponse(request,"settings.response",{settings:DEFAULT_SETTINGS});
    vi.stubGlobal("chrome",{runtime:{sendMessage:()=>Promise.resolve(success)}});
    await expect(sendRuntimeRequest(request)).resolves.toEqual(success);
    vi.stubGlobal("chrome",{runtime:{sendMessage:(_request:unknown,callback:(raw:unknown)=>void)=>{callback(success);return Promise.reject(new Error("late duplicate"));}}});
    await expect(sendRuntimeRequest(request)).resolves.toEqual(success);
  });
});
