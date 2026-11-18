import assert from "node:assert/strict";
import { it } from "node:test";
import { mkdtemp, mkdir, writeFile, readFile, rm, chmod } from "node:fs/promises";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { createCopilotLlm, probeCopilotLlm } from "./llm-copilot.js";
import { createGeminiLlm, GEMINI_DEFAULT_MODEL, probeGeminiLlm } from "./llm-gemini.js";
import { cliProviderEnv, CliProviderError, cliFailure } from "./cli-provider.js";

async function fixture(provider: "copilot" | "gemini", scenario = "ok") {
  const folder = await mkdtemp(join(tmpdir(), "openadminos-cli-test-"));
  const capture = join(folder, "capture.json");
  let binaryPath = join(folder, provider);
  let scriptPath = binaryPath;
  if (process.platform === "win32") {
    binaryPath += ".cmd";
    scriptPath = join(folder, "node_modules", provider === "copilot" ? "@github/copilot/npm-loader.js" : "@google/gemini-cli/bundle/gemini.js");
    await mkdir(dirname(scriptPath), { recursive: true });
    await writeFile(binaryPath, "@exit /b 99\r\n");
  }
  const script = `#!/usr/bin/env node
const fs = require('node:fs');
const scenario = ${JSON.stringify(scenario)}, capture = ${JSON.stringify(capture)};
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log(${JSON.stringify(provider === "copilot" ? "1.0.83" : "0.59.0")}); process.exit(0); }
if (${JSON.stringify(provider)} === 'gemini') {
  const settings = JSON.parse(fs.readFileSync(process.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH, 'utf8'));
  const system = fs.readFileSync(process.env.GEMINI_SYSTEM_MD, 'utf8');
  const policy = fs.readFileSync(args[args.indexOf('--admin-policy')+1], 'utf8');
  fs.writeFileSync(capture, JSON.stringify({args,settings,system,policy,pid:process.pid,cwd:process.cwd()}));
  let prompt=''; process.stdin.on('data',d=>prompt+=d);
  process.stdin.on('end',()=>{
    if(scenario==='hang'){setInterval(()=>{},1000);return;}
    if(scenario==='auth'){console.error('Authentication required SECRET_SHOULD_NOT_LEAK');process.exit(1);}
    if(scenario==='tool'){console.log(JSON.stringify({type:'tool_use',tool_name:'run_shell_command'}));setInterval(()=>{},1000);return;}
    if(scenario==='invalid'){console.log('{bad json');process.exit(0);}
    console.log(JSON.stringify({type:'init',model:'gemini-test-model'}));
    console.log(JSON.stringify({type:'message',role:'user',content:prompt}));
    console.log(JSON.stringify({type:'message',role:'assistant',content:'Hello 🌍',delta:true}));
    if(scenario!=='truncated') console.log(JSON.stringify({type:'result',status:'success'}));
  });
} else {
  let input=Buffer.alloc(0), sessionId;
  function emit(value){const body=JSON.stringify(value);const frame=Buffer.from('Content-Length: '+Buffer.byteLength(body)+'\\r\\n\\r\\n'+body);process.stdout.write(frame.subarray(0,9));process.stdout.write(frame.subarray(9));}
  process.stdin.on('data',data=>{
    input=Buffer.concat([input,data]);
    while(true){const end=input.indexOf('\\r\\n\\r\\n');if(end<0)return;const size=Number(/Content-Length: (\\d+)/i.exec(input.subarray(0,end).toString())[1]);if(input.length<end+4+size)return;const request=JSON.parse(input.subarray(end+4,end+4+size).toString());input=input.subarray(end+4+size);
      if(!request.method)continue;
      const reply=result=>emit({jsonrpc:'2.0',id:request.id,result});
      if(request.method==='ping')reply({protocolVersion:2});
      else if(request.method==='auth.getStatus')reply({isAuthenticated:scenario!=='auth'});
      else if(request.method==='models.list') { if(scenario==='denied')emit({jsonrpc:'2.0',id:request.id,error:{code:403,message:'policy denied SECRET_SHOULD_NOT_LEAK'}});else if(scenario==='empty')reply({models:[]});else if(scenario.startsWith('fusion'))reply({models:scenario==='fusion-paid'?[{id:'copilot-test-model'}]:[],auto:{defaultTier:'balance',tiers:[{id:'balance',displayName:'Standard',type:'auto',fusionTier:'standard',status:scenario==='fusion-none'?{enabled:false,reason:'policy_disabled'}:{enabled:true,pickerVisible:true}},{id:'hydrafusion',displayName:'High',type:'fusion',fusionTier:'high',status:scenario==='fusion-paid'?{enabled:true}:{enabled:false,pickerVisible:true,reason:'user_not_eligible',message:'This tier is not available for the user SECRET_SHOULD_NOT_LEAK'}},{id:'hydrafusion-max',displayName:'Max',type:'fusion',fusionTier:'max',status:{enabled:false,reason:'policy_disabled'}},{id:'fast',displayName:'Fast',type:'auto',status:{enabled:true,pickerVisible:false}}]}});else reply({models:[{id:'copilot-test-model'}]}); }
      else if(request.method==='session.create'){sessionId=request.params.sessionId;fs.writeFileSync(capture,JSON.stringify({...request.params,pid:process.pid}));const tier=request.params.capi&&request.params.capi.fusionTier;reply(tier?{sessionId,modelState:{modelId:'auto',fusionTier:scenario==='fusion-wrong-tier'?'standard':tier}}:{sessionId});}
      else if(request.method==='session.send'){
        reply({messageId:'user-1'});
        const event=(type,data)=>emit({jsonrpc:'2.0',method:'session.event',params:{sessionId,event:{type,data}}});
        if(scenario==='hang')continue;
        if(scenario==='tool'){event('tool.execution_start',{});continue;}
        if(scenario==='fusion-draft'||scenario==='two-answers'){
          event('assistant.message_delta',{messageId:'draft-1',deltaContent:'Draft'});
          event('assistant.message',{messageId:'draft-1',content:'Draft',fusion:{commitId:null,fusionId:'f-1',pattern:'critique',policy:'hydrafusion',syntheticModel:'fusion'}});
          event('assistant.message_delta',{messageId:'revision-1',deltaContent:'Final '});
          event('assistant.message_delta',{messageId:'revision-1',deltaContent:'answer'});
          event('assistant.message',{messageId:'revision-1',content:'Final answer',fusion:{commitId:'commit-1',fusionId:'f-1',pattern:'critique',policy:'hydrafusion',syntheticModel:'fusion'}});
          event('assistant.message_delta',{messageId:'late-1',deltaContent:'Ignored'});
          event('assistant.message',{messageId:'late-1',content:'Ignored'});
          event('session.idle',{});
          continue;
        }
        event('assistant.message_delta',{messageId:'answer-1',deltaContent:'Hello 🌍'});
        event('assistant.message',{content:'Hello 🌍'});
        if(scenario!=='truncated')event('session.idle',{});
      } else if(request.method==='session.delete'){reply({success:true});}
    }
  });
}
`;
  await writeFile(scriptPath, script); await chmod(scriptPath, 0o755);
  return { binaryPath, capture: async () => JSON.parse(await readFile(capture, "utf8")), cleanup: () => rm(folder, { recursive: true, force: true }) };
}

it("isolates CLI environments from unrelated secrets, hooks, provider redirects and telemetry exporters", () => {
  const source = { HOME: "/home/test", PATH: "/bin", GH_TOKEN: "test-gh", GEMINI_API_KEY: "test-google", OPENAI_API_KEY: "private", NODE_OPTIONS: "--require malicious", BASH_ENV: "hook", COPILOT_PROVIDER_BASE_URL: "https://other.example", GOOGLE_GEMINI_BASE_URL: "https://other.example", OTEL_EXPORTER_OTLP_ENDPOINT: "https://other.example" };
  const copilot = cliProviderEnv("copilot", source), gemini = cliProviderEnv("gemini", source);
  assert.equal(copilot.GH_TOKEN, "test-gh"); assert.equal(gemini.GEMINI_API_KEY, "test-google");
  assert.equal(copilot.GEMINI_API_KEY, undefined); assert.equal(gemini.GH_TOKEN, undefined);
  for (const env of [copilot, gemini]) for (const name of ["OPENAI_API_KEY", "NODE_OPTIONS", "BASH_ENV", "COPILOT_PROVIDER_BASE_URL", "GOOGLE_GEMINI_BASE_URL", "OTEL_EXPORTER_OTLP_ENDPOINT"]) assert.equal(env[name], undefined);
});

it("checks Copilot authentication and model access independently", async () => {
  for (const scenario of ["ok", "auth", "denied"]) {
    const f = await fixture("copilot", scenario);
    try {
      const probe = await probeCopilotLlm({ binaryPath: f.binaryPath });
      assert.equal(probe.installed, true); assert.equal(probe.ready, scenario === "ok");
      assert.equal(probe.failure, scenario === "auth" ? "signed-out" : scenario === "denied" ? "access-denied" : undefined);
      assert.doesNotMatch(probe.detail, /SECRET/);
    } finally { await f.cleanup(); }
  }
});

it("offers the Copilot Fusion tiers the account can use and lists the rest as unavailable", async () => {
  const free = await fixture("copilot", "fusion-free");
  try {
    // Copilot Free lists no regular model, only Fusion Standard.
    const probe = await probeCopilotLlm({ binaryPath: free.binaryPath });
    assert.equal(probe.ready, true);
    assert.deepEqual(probe.models, ["fusion-standard"]);
    assert.deepEqual(probe.modelLabels, { "fusion-standard": "Copilot Fusion Standard", "fusion-high": "Copilot Fusion High", "fusion-max": "Copilot Fusion Max" });
    assert.deepEqual(probe.unavailableModels, [
      { id: "fusion-high", reason: "Not included in your Copilot plan. Fusion High needs a Copilot Pro+, Max, Business or Enterprise plan." },
      { id: "fusion-max", reason: "Not available for this account. Check your Copilot plan and organization policy, then refresh providers." },
    ]);
    assert.doesNotMatch(JSON.stringify(probe), /SECRET/);
  } finally { await free.cleanup(); }
  const paid = await fixture("copilot", "fusion-paid");
  try {
    const probe = await probeCopilotLlm({ binaryPath: paid.binaryPath });
    // Regular models stay first, so the CLI's default remains the first choice.
    assert.deepEqual(probe.models, ["copilot-test-model", "fusion-standard", "fusion-high"]);
    assert.deepEqual(probe.unavailableModels?.map((m) => m.id), ["fusion-max"]);
  } finally { await paid.cleanup(); }
  const plain = await fixture("copilot");
  try {
    const probe = await probeCopilotLlm({ binaryPath: plain.binaryPath });
    assert.deepEqual(probe.models, ["copilot-test-model"]);
    assert.equal(probe.modelLabels, undefined); assert.equal(probe.unavailableModels, undefined);
  } finally { await plain.cleanup(); }
  const empty = await fixture("copilot", "empty");
  try { assert.equal((await probeCopilotLlm({ binaryPath: empty.binaryPath })).failure, "access-denied"); }
  finally { await empty.cleanup(); }
  // Nothing selectable: still access denied, and each tier keeps its reason.
  const none = await fixture("copilot", "fusion-none");
  try {
    const probe = await probeCopilotLlm({ binaryPath: none.binaryPath });
    assert.equal(probe.ready, false); assert.equal(probe.failure, "access-denied"); assert.deepEqual(probe.models, []);
    assert.deepEqual(probe.unavailableModels?.map((m) => m.id), ["fusion-standard", "fusion-high", "fusion-max"]);
    assert.equal(probe.modelLabels?.["fusion-standard"], "Copilot Fusion Standard");
  } finally { await none.cleanup(); }
});

it("starts a Copilot Fusion tier as the fusion model and refuses a session on another tier", async () => {
  const f = await fixture("copilot", "fusion-free");
  try {
    const answer = await createCopilotLlm({ binaryPath: f.binaryPath }).complete({ prompt: "Answer" });
    assert.equal(answer.text, "Hello 🌍");
    let capture = await f.capture();
    assert.equal(capture.model, undefined); assert.equal(capture.capi, undefined);
    await createCopilotLlm({ binaryPath: f.binaryPath, defaultModel: "fusion-high" }).complete({ prompt: "Answer" });
    capture = await f.capture();
    assert.equal(capture.model, "fusion"); assert.deepEqual(capture.capi, { fusionTier: "high" }); assert.deepEqual(capture.availableTools, []);
  } finally { await f.cleanup(); }
  const wrong = await fixture("copilot", "fusion-wrong-tier");
  try {
    await assert.rejects(createCopilotLlm({ binaryPath: wrong.binaryPath }).complete({ prompt: "Answer", model: "fusion-max" }), /did not start Copilot Fusion Max\. Update the Copilot CLI/);
  } finally { await wrong.cleanup(); }
});

it("keeps the selected Fusion output when Fusion revises a draft, and refuses a second answer from other models", async () => {
  const f = await fixture("copilot", "fusion-draft");
  try {
    const chunks = [];
    for await (const chunk of createCopilotLlm({ binaryPath: f.binaryPath }).stream({ prompt: "Answer", model: "fusion-standard" })) chunks.push(chunk);
    assert.ok(chunks.some((chunk) => chunk.accumulated === "Draft"));
    // A draft marked with a null commit id is not final; the committed revision is.
    assert.equal(chunks.at(-1)?.accumulated, "Final answer"); assert.equal(chunks.at(-1)?.done, true);
    assert.equal(chunks.at(-1)?.model, "fusion-standard");
    // High and Max can draft and revise: GitHub shows only the final response, so no draft is streamed.
    const high = [];
    for await (const chunk of createCopilotLlm({ binaryPath: f.binaryPath }).stream({ prompt: "Answer", model: "fusion-high" })) high.push(chunk);
    assert.deepEqual(high.map((chunk) => chunk.accumulated), ["Final answer", "Final answer"]);
    assert.equal(high.at(-1)?.done, true);
  } finally { await f.cleanup(); }
  const other = await fixture("copilot", "two-answers");
  try { await assert.rejects(createCopilotLlm({ binaryPath: other.binaryPath }).complete({ prompt: "Answer" }), /unexpected additional answer/); }
  finally { await other.cleanup(); }
});

for (const provider of ["copilot", "gemini"] as const) {
  const create = provider === "copilot" ? createCopilotLlm : createGeminiLlm;
  it(`${provider} streams Unicode text and uses an isolated execution context`, async () => {
    const f = await fixture(provider);
    try {
      const chunks = [];
      for await (const chunk of create({ binaryPath: f.binaryPath }).stream({ prompt: '"A & B" | %PATH% $HOME', system: "Only supplied tenant evidence." })) chunks.push(chunk);
      assert.equal(chunks.at(-1)?.accumulated, "Hello 🌍"); assert.equal(chunks.at(-1)?.done, true); assert.equal(chunks[0]?.done, false);
      const capture = await f.capture();
      if (provider === "copilot") {
        assert.deepEqual(capture.availableTools, []); assert.equal(capture.enableFileHooks, false); assert.equal(capture.enableConfigDiscovery, false); assert.equal(capture.enableSkills, false); assert.equal(capture.remoteSession, "off");
        assert.equal(capture.systemMessage.content, "Only supplied tenant evidence.");
      } else {
        assert.equal(capture.settings.hooksConfig.enabled, false); assert.equal(capture.settings.admin.mcp.enabled, false); assert.equal(capture.settings.admin.extensions.enabled, false);
        assert.match(capture.policy, /decision = "deny"/); assert.equal(capture.system, "Only supplied tenant evidence.");
        assert.equal((await probeGeminiLlm({ binaryPath: f.binaryPath })).ready, true);
      }
    } finally { await f.cleanup(); }
  });
  it(`${provider} rejects tool execution instead of accepting an agent side effect`, async () => {
    const f = await fixture(provider, "tool");
    try { await assert.rejects(create({ binaryPath: f.binaryPath, timeoutMs: 3000 }).complete({ prompt: "Run a tool" }), /unavailable tool/); }
    finally { await f.cleanup(); }
  });
  it(`${provider} aborts an active request and rejects truncated responses`, async () => {
    const f = await fixture(provider, "hang");
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 1500);
      await assert.rejects(create({ binaryPath: f.binaryPath, timeoutMs: 4000 }).complete({ prompt: "Wait", signal: controller.signal }), /cancelled|aborted/i);
      clearTimeout(timer);
    } finally { await f.cleanup(); }
    const truncated = await fixture(provider, "truncated");
    try { await assert.rejects(create({ binaryPath: truncated.binaryPath, timeoutMs: 1500 }).complete({ prompt: "Answer" }), /timed out|complete answer/); }
    finally { await truncated.cleanup(); }
  });
}

it("Gemini remains unverified until a successful request, and sign-in errors clear readiness without leaking stderr", async () => {
  const f = await fixture("gemini", "auth");
  try {
    assert.equal((await probeGeminiLlm({ binaryPath: f.binaryPath })).ready, false);
    await assert.rejects(createGeminiLlm({ binaryPath: f.binaryPath }).complete({ prompt: "Test" }), (error: unknown) => error instanceof CliProviderError && error.failure === "signed-out" && !error.message.includes("SECRET"));
    assert.equal((await probeGeminiLlm({ binaryPath: f.binaryPath })).failure, "signed-out");
  } finally { await f.cleanup(); }
});

it("Gemini probe advertises a selectable default model without forcing --model", async () => {
  const f = await fixture("gemini");
  try {
    const probe = await probeGeminiLlm({ binaryPath: f.binaryPath });
    assert.deepEqual(probe.models, [GEMINI_DEFAULT_MODEL]);
    assert.equal(probe.defaultModel, GEMINI_DEFAULT_MODEL);
    const answer = await createGeminiLlm({ binaryPath: f.binaryPath }).complete({ prompt: "Hi", model: GEMINI_DEFAULT_MODEL });
    assert.equal(answer.text, "Hello 🌍");
    const capture = await f.capture();
    assert.equal(capture.args.includes("--model"), false);
  } finally { await f.cleanup(); }
});

it("distinguishes expired credentials, denied access, and transport errors", () => {
  assert.equal(cliFailure("CLI", "401 unauthorized").failure, "signed-out");
  assert.equal(cliFailure("CLI", "403 Forbidden").failure, "access-denied");
  assert.equal(cliFailure("CLI", "socket closed").failure, "request-failed");
});
