import "./test-env.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
const moduleUrl = new URL("../scripts/qualify-peer-live.mjs", import.meta.url);
import * as api from "../scripts/qualify-peer-live.mjs";
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cc-live-gate-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return fs.realpathSync(root);
}
test("inventory sees ignored files, empty directories, modes and symlink targets without following links", (t) => {
  const root=fixture(t), repo=path.join(root,"workspace");fs.mkdirSync(repo);
  fs.writeFileSync(path.join(repo,".gitignore"),"ignored\n");
  fs.writeFileSync(path.join(repo,"ignored"),"a");fs.mkdirSync(path.join(repo,"empty"));
  fs.symlinkSync("../missing",path.join(repo,"link"));
  const before=api.inventoryWorkspace(repo);
  assert.deepEqual(before.map(x=>x.path),[".",".gitignore","empty","ignored","link"]);
  assert.equal(before.find(x=>x.path==="ignored").sha256,"ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb");
  assert.equal(before.find(x=>x.path==="link").target,"../missing");
  fs.chmodSync(path.join(repo,"ignored"),0o700);
  assert.notDeepEqual(api.inventoryWorkspace(repo),before,"mode-only mutation was missed");
  fs.unlinkSync(path.join(repo,"link"));fs.symlinkSync(".",path.join(repo,"link"));
  assert.equal(api.inventoryWorkspace(repo).find(x=>x.path==="link").target,".");
  fs.rmdirSync(path.join(repo,"empty"));
  assert.ok(!api.inventoryWorkspace(repo).some(x=>x.path==="empty"));
});
function schemas(root, dialect="http://json-schema.org/draft-07/schema#") {
  fs.mkdirSync(path.join(root,"schemas"), {recursive:true});
  for(const kind of ["design","research","critique"]) fs.writeFileSync(path.join(root,`schemas/peer-${kind}-output.schema.json`),JSON.stringify({$schema:dialect,type:"object"}));
}
function git(cwd,...args) { return execFileSync("git",args,{cwd,encoding:"utf8"}).trim(); }
test("runtime identity compares installed bytes with an exact local tag, and distinguishes candidate commits", (t) => {
  const root=fixture(t), source=path.join(root,"source"),runtime=path.join(root,"runtime");
  for(const dir of [source,runtime]) {fs.mkdirSync(dir);schemas(dir);fs.mkdirSync(path.join(dir,"scripts"));fs.writeFileSync(path.join(dir,"package.json"),JSON.stringify({version:"1.0.0",files:["scripts","schemas"]}));fs.writeFileSync(path.join(dir,"scripts/main.mjs"),"export const value=1;\n");}
  git(source,"init","-q");git(source,"add",".");git(source,"-c","user.name=Fixture","-c","user.email=fixture@example.invalid","-c","core.hooksPath=/dev/null","commit","-qm","fixture");git(source,"tag","v1.0.0");
  const revision=git(source,"rev-parse","HEAD");
  const options={sourceRepo:source,runtimeRoot:runtime,revision:"v1.0.0",mode:"installed"};
  const identity=api.verifyRuntimeIdentity(options);assert.equal(identity.commit,revision);assert.equal(identity.mode,"installed");
  assert.throws(()=>api.verifyRuntimeIdentity({...options,revision}),/tag/i);
  assert.equal(api.verifyRuntimeIdentity({...options,mode:"candidate",revision}).mode,"candidate");
  fs.writeFileSync(path.join(runtime,"scripts/extra.mjs"),"untracked runtime code\n");
  assert.throws(()=>api.verifyRuntimeIdentity(options),/extra|unexpected|set/i,"extra shipped-path file passed");
  fs.unlinkSync(path.join(runtime,"scripts/extra.mjs"));
  fs.mkdirSync(path.join(runtime,"scripts/extra"));
  assert.throws(()=>api.verifyRuntimeIdentity(options),/extra|unexpected|set/i,"extra empty directory passed");
  fs.rmdirSync(path.join(runtime,"scripts/extra"));
  assert.throws(()=>api.verifyRuntimeIdentity({...options,mode:"candidate",revision:"HEAD"}),/commit|revision/i,"moving candidate ref passed");
  fs.writeFileSync(path.join(runtime,"scripts/main.mjs"),"export const value=2;\n");
  assert.throws(()=>api.verifyRuntimeIdentity(options),/mismatch/i,"same version with different runtime bytes passed");
  fs.copyFileSync(path.join(source,"scripts/main.mjs"),path.join(runtime,"scripts/main.mjs"));
  for(const prefix of ["scripts/*.mjs","scripts/","./scripts"]) {
    for(const dir of [source,runtime]) fs.writeFileSync(path.join(dir,"package.json"),JSON.stringify({version:"1.0.0",files:[prefix,"schemas"]}));
    git(source,"add",".");git(source,"-c","user.name=Fixture","-c","user.email=fixture@example.invalid","-c","core.hooksPath=/dev/null","commit","-qm","unsupported shipped prefix");
    assert.throws(()=>api.verifyRuntimeIdentity({...options,mode:"candidate",revision:git(source,"rev-parse","HEAD")}),/prefix|shipped|file list/i,prefix);
  }
  for(const dir of [source,runtime]) fs.writeFileSync(path.join(dir,"package.json"),JSON.stringify({version:"1.0.0",files:["scripts","schemas"]}));
  // Published v1.7.12 lists an absent literal "agents" directory. It adds no shipped files.
  for(const dir of [source,runtime]) fs.writeFileSync(path.join(dir,"package.json"),JSON.stringify({version:"1.0.0",files:["scripts","schemas","agents"]}));
  git(source,"add",".");git(source,"-c","user.name=Fixture","-c","user.email=fixture@example.invalid","-c","core.hooksPath=/dev/null","commit","-qm","absent literal directory");
  assert.equal(api.verifyRuntimeIdentity({...options,mode:"candidate",revision:git(source,"rev-parse","HEAD")}).fileCount,5);
  for(const dir of [source,runtime]) schemas(dir,"https://json-schema.org/draft/2020-12/schema");
  git(source,"add",".");git(source,"-c","user.name=Fixture","-c","user.email=fixture@example.invalid","-c","core.hooksPath=/dev/null","commit","-qm","unsupported schema");
  assert.throws(()=>api.verifyRuntimeIdentity({...options,mode:"candidate",revision:git(source,"rev-parse","HEAD")}),/Draft.?07|schema/i,"unsupported native schema dialect passed");
});
const brave=["mcp__brave-search__brave_web_search","mcp__brave-search__brave_llm_context"];
function workflow(root) {
  const model={requestedModel:"claude-sonnet-5-5",finalModel:"claude-sonnet-5-5",contextWindow:1000000,modelFallbacks:[],streamDiagnostics:[],advisor:undefined};
  const memo={content:{findings:["private memo"]},repoCitations:[{path:path.join(root,"source.txt"),line:1}],webCitations:["https://example.com/docs"],toolEvents:[{tool:"Read"},...brave.map(tool=>({tool}))],model};
  return {id:"fixture",epoch:0,revision:4,mode:"research",workspaceRoot:root,status:"completed",branchAttempts:[],modelManifest:[{role:"claude",requestedModel:model.requestedModel}],toolManifest:brave.map(toolId=>({toolId})),branches:{codex:{status:"completed",attempts:1,payload:memo},claude:{status:"completed",attempts:1,payload:memo}},stages:{critique:{status:"completed",attempts:1,payload:{content:{critique:"private critique"},toolEvents:[],model}}}};
}
test("a successful same-epoch retry cannot hide a failed native attempt", async (t) => {
  const {reserveWorkflow,reserveWorkflowAttempts,activateWorkflowAttempt,markWorkflowBranchFailure,submitWorkflowStage}=await import("../scripts/lib/workflows.mjs");
  const root=fixture(t);fs.writeFileSync(path.join(root,"source.txt"),"source\n");
  git(root,"init","-q");git(root,"add",".");git(root,"-c","user.name=Fixture","-c","user.email=fixture@example.invalid","-c","core.hooksPath=/dev/null","commit","-qm","fixture");
  const wf=workflow(root);
  let current=reserveWorkflow(root,{id:"retried",mode:"research",brief:"Retry qualification",originSessionId:"fixture-owner",branches:["codex","claude"],stages:["critique"],modelManifest:wf.modelManifest,toolManifest:wf.toolManifest});
  for(let attempt=1;attempt<=2;attempt++) {
    const options={epoch:0,revision:current.revision,stage:"memo",branchId:"claude"};
    const reserved=reserveWorkflowAttempts(root,current.id,options,[{stage:"memo",branchId:"claude"}]);
    const lease=reserved.leases["branch:claude"];
    current=activateWorkflowAttempt(root,current.id,{...options,revision:reserved.workflow.revision,lease});
    const active={...options,revision:current.revision,lease};
    current=attempt===1?markWorkflowBranchFailure(root,current.id,{...active,reason:"CLAUDE_TURN_FAILED"}):submitWorkflowStage(root,current.id,{...active,payload:wf.branches.claude.payload});
  }
  current=submitWorkflowStage(root,current.id,{epoch:0,revision:current.revision,stage:"memo",branchId:"codex",oneShot:true,payload:wf.branches.codex.payload});
  current=submitWorkflowStage(root,current.id,{epoch:0,revision:current.revision,stage:"critique",oneShot:true,payload:wf.stages.critique.payload,status:"completed"});
  assert.equal(current.epoch,0);assert.equal(current.failureReason,null);assert.equal(current.branches.claude.attempts,2);
  assert.throws(()=>api.verifyPeerEvidence(current),/attempt|retry|failure/i);
});
test("qualification uses both exact selected Brave tools and bounded model evidence, without publishing memo content", (t) => {
  const root=fixture(t);fs.writeFileSync(path.join(root,"source.txt"),"source\n");
  const wf=workflow(root),result=api.verifyPeerEvidence(wf);
  assert.equal(result.id,"fixture");assert.equal(result.memoModel.finalModel,"claude-sonnet-5-5");
  assert.ok(!JSON.stringify(result).includes("private"));
  const nativeTools=structuredClone(wf);nativeTools.branches.claude.payload.toolEvents.push({tool:"ToolSearch"},{tool:"StructuredOutput"});assert.doesNotThrow(()=>api.verifyPeerEvidence(nativeTools));
  const writeTool=structuredClone(wf);writeTool.branches.claude.payload.toolEvents.push({tool:"Write"});assert.throws(()=>api.verifyPeerEvidence(writeTool),/unselected tool/i);
  for(const bad of ["mcp__brave-search__brave_web_search_fake","mcp__other__brave_web_search","WebSearch"]) {
    const changed=structuredClone(wf);changed.branches.claude.payload.toolEvents[1].tool=bad;
    assert.throws(()=>api.verifyPeerEvidence(changed),/tool|Brave/i,bad);
  }
  const unselected=structuredClone(wf);unselected.toolManifest.pop();assert.throws(()=>api.verifyPeerEvidence(unselected),/Brave|manifest/i);
  const missing=structuredClone(wf);missing.branches.claude.payload.model.finalModel=null;assert.throws(()=>api.verifyPeerEvidence(missing),/model/i);
  const failed=structuredClone(wf);failed.failureReason="CLAUDE_TURN_FAILED";assert.throws(()=>api.verifyPeerEvidence(failed),/failure/i);
  const mismatched=structuredClone(wf);mismatched.branches.claude.payload.model.requestedModel="claude-haiku-5-5";assert.throws(()=>api.verifyPeerEvidence(mismatched),/model|manifest/i);
  const silent=structuredClone(wf);silent.branches.claude.payload.model.finalModel="claude-haiku-5-5";assert.throws(()=>api.verifyPeerEvidence(silent),/model/i);
  const pending=structuredClone(wf);pending.stages.critique.status="pending";assert.throws(()=>api.verifyPeerEvidence(pending),/critique/i);
});

test("candidate advisor observations match the frozen policy in both native stages", (t) => {
  const root=fixture(t);fs.writeFileSync(path.join(root,"source.txt"),"source\n");
  const wf=workflow(root);
  wf.modelManifest.push({role:"claude-advisor",requestedModel:"fable"});
  assert.throws(()=>api.verifyPeerEvidence(wf),/advisor/i,"candidate without advisor evidence passed");
  const advisor={requested:"fable",calls:2,countExact:true,observedModel:null,status:"observed",diagnostics:[],privatePayload:"never export"};
  wf.branches.claude.payload.model.advisor=advisor;
  wf.stages.critique.payload.model.advisor=advisor;
  const result=api.verifyPeerEvidence(wf);
  assert.equal(result.memoModel.advisor.calls,2);
  assert.equal(result.critiqueModel.advisor.observedModel,null);
  assert.ok(!JSON.stringify(result).includes("never export"));
  for (const role of ["memo","critique"]) {
    const changed=structuredClone(wf);
    const payload=role==="memo"?changed.branches.claude.payload:changed.stages.critique.payload;
    payload.model={...payload.model,advisor:{...advisor,requested:"off"}};
    assert.throws(()=>api.verifyPeerEvidence(changed),/advisor/i,"advisor policy mismatch passed");
  }
  advisor.calls=-1;
  assert.throws(()=>api.verifyPeerEvidence(wf),/advisor/i,"invalid advisor count passed");
  advisor.calls=2;advisor.requested="x".repeat(1000);wf.modelManifest.find(entry=>entry.role==="claude-advisor").requestedModel=advisor.requested;
  assert.throws(()=>api.verifyPeerEvidence(wf),/advisor/i,"unbounded advisor policy passed");
});

test("qualification rejects model aliases instead of treating them as an exact generation", (t) => {
  const root=fixture(t);fs.writeFileSync(path.join(root,"source.txt"),"source\n");
  const wf=workflow(root);wf.modelManifest[0].requestedModel="sonnet";
  for(const payload of [wf.branches.claude.payload,wf.stages.critique.payload]) payload.model={...payload.model,requestedModel:"sonnet",finalModel:"claude-haiku-5-5"};
  assert.throws(()=>api.verifyPeerEvidence(wf),/model/i);
});

test("qualification rejects incomplete or contradictory advisor observations", (t) => {
  const root=fixture(t);fs.writeFileSync(path.join(root,"source.txt"),"source\n");
  /** @type {[string, number, boolean, string][]} */
  const cases=[["off",1,true,"observed"],["fable",0,false,"incomplete"],["fable",1,false,"observed"],["fable",0,true,"observed"],["fable",1,true,"not_observed"]];
  for(const [policy,calls,countExact,status] of cases) {
    const wf=workflow(root);wf.modelManifest.push({role:"claude-advisor",requestedModel:policy});
    const advisor={requested:policy,calls,countExact,observedModel:null,status,diagnostics:[]};
    for(const payload of [wf.branches.claude.payload,wf.stages.critique.payload]) payload.model={...payload.model,advisor};
    assert.throws(()=>api.verifyPeerEvidence(wf),/advisor/i,JSON.stringify(advisor));
  }
  const wf=workflow(root);wf.modelManifest.push({role:"claude-advisor",requestedModel:null});
  for(const payload of [wf.branches.claude.payload,wf.stages.critique.payload]) payload.model={...payload.model,advisor:{requested:"inherit",calls:0,countExact:true,observedModel:null,status:"not_observed",diagnostics:[]}};
  assert.equal(api.verifyPeerEvidence(wf).memoModel.advisor.requested,"inherit");
});

test("manual live gate refuses implicit use, captures outside the workspace and rejects later file or manifest drift", async (t) => {
  const { spawnSync } = await import("node:child_process");
  const command = (args) => spawnSync(process.execPath, [moduleUrl.pathname, ...args], { encoding:"utf8" });
  assert.notEqual(command([]).status, 0, "live gate must require explicit opt-in");
  const { reserveWorkflow, resolveWorkflowFile } = await import("../scripts/lib/workflows.mjs");
  const root=fixture(t),source=path.join(root,"source"),repo=path.join(root,"workspace");
  fs.mkdirSync(source);schemas(source);fs.writeFileSync(path.join(source,"package.json"),JSON.stringify({version:"1.0.0",files:["source.txt","schemas"]}));fs.writeFileSync(path.join(source,"source.txt"),"source\n");
  git(source,"init","-q");git(source,"add",".");git(source,"-c","user.name=Fixture","-c","user.email=fixture@example.invalid","-c","core.hooksPath=/dev/null","commit","-qm","fixture");
  git(source,"worktree","add","--detach",repo,"HEAD");
  const wf=workflow(repo);const created=reserveWorkflow(repo,{id:"fixture",mode:"research",brief:"Synthetic gate fixture",originSessionId:"fixture-owner",branches:["codex","claude"],stages:["critique"],modelManifest:wf.modelManifest,toolManifest:wf.toolManifest});
  const baseline=path.join(root,"baseline.json"),report=path.join(root,"report.json");
  const flags=["--live","capture","--workspace",repo,"--runtime-root",source,"--source-repo",source,"--revision",git(source,"rev-parse","HEAD"),"--mode","candidate","--workflow-id","fixture"];
  const refused=command([...flags,"--output",path.join(repo,"baseline.json")]);assert.notEqual(refused.status,0);assert.ok(!fs.existsSync(path.join(repo,"baseline.json")));
  const captured=command([...flags,"--output",baseline]);assert.equal(captured.status,0,captured.stderr);
  const stored={...created,...wf,revision:5};fs.writeFileSync(resolveWorkflowFile(repo,"fixture"),JSON.stringify(stored));
  const verify=["--live","verify","--baseline",baseline,"--output",report];
  const missingAdvisor=command(verify);assert.notEqual(missingAdvisor.status,0,"candidate without frozen advisor policy passed");assert.match(missingAdvisor.stderr,/advisor/i);assert.ok(!fs.existsSync(report));
  wf.modelManifest.push({role:"claude-advisor",requestedModel:"off"});
  for(const payload of [wf.branches.claude.payload,wf.stages.critique.payload]) payload.model.advisor={requested:"off",calls:0,countExact:true,observedModel:null,status:"not_observed",diagnostics:[]};
  fs.unlinkSync(baseline);fs.writeFileSync(resolveWorkflowFile(repo,"fixture"),JSON.stringify({...created,modelManifest:wf.modelManifest}));
  assert.equal(command([...flags,"--output",baseline]).status,0);
  fs.writeFileSync(resolveWorkflowFile(repo,"fixture"),JSON.stringify(stored));
  const verified=command(verify);assert.equal(verified.status,0,verified.stderr);assert.equal(JSON.parse(fs.readFileSync(report,"utf8")).runtime.mode,"candidate");
  assert.ok(!fs.readFileSync(report,"utf8").includes("private"));fs.unlinkSync(report);
  fs.writeFileSync(path.join(repo,"new-ignored-file"),"change");assert.notEqual(command(verify).status,0);assert.ok(!fs.existsSync(report));fs.unlinkSync(path.join(repo,"new-ignored-file"));
  stored.toolManifest.pop();fs.writeFileSync(resolveWorkflowFile(repo,"fixture"),JSON.stringify(stored));assert.notEqual(command(verify).status,0);assert.ok(!fs.existsSync(report));
});


test("live gate accepts advisor metadata from the native stream producer", async (t) => {
  const {StreamParser,summarizeAdvisorTelemetry}=await import("../scripts/lib/claude-cli.mjs");
  const root=fixture(t);fs.writeFileSync(path.join(root,"source.txt"),"source\n");
  const native=JSON.parse(fs.readFileSync(new URL("./fixtures/advisor-evidence.json",import.meta.url),"utf8"));
  /** @type {[string | null, unknown[], number][]} */
  const cases=[[null,[],0],["off",[],0],["fable",[native.call,native.result],1]];
  for(const [policy,blocks,count] of cases) {
    const parser=new StreamParser();parser.feed(JSON.stringify({type:"assistant",message:{model:native.primaryModel,content:blocks}})+"\n");
    const advisor=summarizeAdvisorTelemetry(parser.state.advisor,policy);
    const wf=workflow(root);wf.modelManifest.push({role:"claude-advisor",requestedModel:policy});
    for(const payload of [wf.branches.claude.payload,wf.stages.critique.payload]) payload.model={...payload.model,advisor};
    const result=api.verifyPeerEvidence(wf);
    assert.equal(result.memoModel.advisor.calls,count);assert.equal(result.critiqueModel.advisor.calls,count);
    assert.equal(result.memoModel.advisor.observedModel,null);
  }
});
