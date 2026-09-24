import { expect, it } from "vitest";
import { readCreativeDraft, writeCreativeDraft } from "./creative-drafts.js";
it("keeps an unfinished creative draft and selection in its own work across a fresh read", () => {
  const entries = new Map<string,string>();
  const storage = {getItem: (k:string)=>entries.get(k)??null, setItem:(k:string,v:string)=>{entries.set(k,v);},removeItem:(k:string)=>{entries.delete(k);}};
  const caseId = "600f2f86-cbd8-47d1-bc44-5de62238ef47", source = "df5869bc-c54a-4d2a-b532-d24ebc4fce64";
  const draft = {caseId,productId:"ai-studio" as const,prompt:"  काग़ज़\nforest green  ",sourceIds:[source]};
  writeCreativeDraft(storage,draft); expect(readCreativeDraft(storage,caseId)).toEqual(draft);
  expect(readCreativeDraft(storage,"44f3e25e-5a2c-4560-af3f-736cebe05c89")).toBeNull();
  const key = [...entries.keys()][0]!; entries.set(key,JSON.stringify({...draft,caseId:"44f3e25e-5a2c-4560-af3f-736cebe05c89"})); expect(readCreativeDraft(storage,caseId)).toBeNull();
});
it("rejects oversized or permission-shaped drafts and reports storage failures instead of success", () => {
  const caseId="600f2f86-cbd8-47d1-bc44-5de62238ef47";
  const draft={caseId,productId:"gemini" as const,prompt:"Study",sourceIds:[]};
  expect(readCreativeDraft({getItem:()=>JSON.stringify({...draft,allowAll:true})},caseId)).toBeNull();
  expect(readCreativeDraft({getItem:()=>"x".repeat(60_001)},caseId)).toBeNull();
  expect(()=>writeCreativeDraft({setItem:()=>{throw new Error("Storage full");},removeItem:()=>{}},draft)).toThrow("Storage full");
});
