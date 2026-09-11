import { runOfficeVisualChecks } from "./office-visual-checks.js";
/** Contributor-only, isolated Electron rehearsal. No production IPC or live tenant writes. */
import type { BrowserWindow } from "electron";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
export async function runOfficeRehearsal(
  window: BrowserWindow,
  outputDir: string,
  advanceEvidence: () => Promise<void>,
) {
  window.webContents.setBackgroundThrottling(false);
  const evaluate = <T>(code: string): Promise<T> =>
    window.webContents.executeJavaScript(code, true);
  const reload = async () => {
    // Waiting only for a selector can match the old document during reload.
    const loaded = new Promise<void>((resolve) =>
      window.webContents.once("did-finish-load", () => resolve()),
    );
    window.webContents.reload();
    await loaded;
  };
  const sleep = (ms: number) =>
    new Promise((resolve) => setTimeout(resolve, ms));
  const wait = async (code: string) => {
    for (let i = 0; i < 200; i++) {
      if (await evaluate<boolean>(code)) return;
      await sleep(100);
    }
    // Preserve fixture execution state before the launcher removes its temporary
    // profile. A timeout alone cannot distinguish a failed child from a slow UI.
    const state = await evaluate(`(async()=>{
      const s=await window.openAdminOS.getAppState();
      return {
        personas:s.office.personas.map(p=>({id:p.id,name:p.name,lastError:p.lastError,enabled:p.enabled})),
        missions:s.office.missions,
        runs:s.runs.map(r=>({id:r.id,agentSlug:r.agentSlug,status:r.status,error:r.error,summary:r.summary,logs:r.logs.slice(-8)}))
      };
    })()`);
    await writeFile(
      join(outputDir, "rehearsal-failure.json"),
      JSON.stringify({ wait: code, state }, null, 2),
    );
    throw new Error(`Rehearsal timed out: ${code}`);
  };
  const frame = async (path: string) => {
    window.webContents.invalidate();
    await window.webContents.capturePage();
    await sleep(70);
    const captured = await window.webContents.capturePage();
    await writeFile(
      path,
      path.endsWith(".jpg") ? captured.toJPEG(85) : captured.toPNG(),
    );
  };
  window.setContentSize(1440, 1000);
  await evaluate(`location.hash='/office'`);
  await wait(`Boolean(document.querySelector('.team-office'))`);
  const ids = await evaluate<{
    source: string;
    research: string;
    chief: string;
  }>(`(async()=>{
   const state=await window.openAdminOS.getAppState();
   const source=state.office.personas.find(p=>p.name==='Policy Watcher');
   const research=state.office.personas.find(p=>p.name==='Device Investigator');
   const chief=state.office.personas.find(p=>p.name==='Chief of Staff');
   await window.openAdminOS.saveOfficePersona({...source,intervalMinutes:null,assessment:{metricPath:'counts.noncompliant',threshold:1},enabled:true});
   await window.openAdminOS.saveOfficePersona({...research,name:'Research Bot',agentSlugs:['team-evidence-review'],assessment:undefined,intervalMinutes:null,watch:{personaId:source.id,event:'changed',cooldownMinutes:5},instructions:'Explain what changed. Cite both source run IDs. Do not infer policy causes from aggregate counts.',enabled:true});
   await window.openAdminOS.saveOfficePersona({...chief,agentSlugs:['team-evidence-review','team-script-draft'],assessment:undefined,intervalMinutes:null,watch:{personaId:research.id,event:'new',cooldownMinutes:5},planning:'model',instructions:'Reuse the investigation. Draft a reviewable next step only; never execute PowerShell.',enabled:true});
   return {source:source.id,research:research.id,chief:chief.id};
 })()`);
  const select = async (id: string) => {
    await evaluate(`location.hash='/office?persona=${id}'`);
    await sleep(200);
  };
  await select(ids.source);
  await evaluate(
    `(()=>{const button=[...document.querySelectorAll('button')].find(b=>b.textContent==='Expand office');if(button.getAttribute('aria-pressed')!=='true')button.click();const banner=document.createElement('p');banner.className='team-rehearsal-banner';banner.textContent='REHEARSAL DATA · Local fixtures · No live tenant writes';document.querySelector('.office-header').append(banner);document.querySelector('.office-page').scrollTop=0;})()`,
  );
  let recording = true,
    recordError: unknown,
    frames = 0;
  await mkdir(join(outputDir, "rehearsal-frames"), { recursive: true });
  const recordingTask = (async () => {
    try {
      while (recording) {
        await frame(
          join(
            outputDir,
            "rehearsal-frames",
            `${String(frames++).padStart(4, "0")}.jpg`,
          ),
        );
        await sleep(110);
      }
    } catch (e) {
      recordError = e;
    }
  })();
  try {
    await evaluate(`window.openAdminOS.startOfficePersona('${ids.source}')`);
    await wait(
      `(async()=>{const s=await window.openAdminOS.getAppState();return s.office.missions.find(m=>m.personaId==='${ids.source}')?.status==='completed';})()`,
    );
    await frame(join(outputDir, "rehearsal-baseline.png"));
    await advanceEvidence();
    await evaluate(`window.openAdminOS.startOfficePersona('${ids.source}')`);
    await wait(
      `(async()=>{const s=await window.openAdminOS.getAppState();return s.office.handoffs.some(h=>h.targetPersonaId==='${ids.research}');})()`,
    );
    await select(ids.research);
    await frame(join(outputDir, "rehearsal-investigation.png"));
    await wait(
      `(async()=>{const s=await window.openAdminOS.getAppState();const m=s.office.missions.find(m=>m.personaId==='${ids.chief}'&&m.handoffId);if(m?.status==='failed')throw new Error(m.error);return m?.status==='completed';})()`,
    );
    await select(ids.chief);
    const evidence = await evaluate<any>(
      `(async()=>{const s=await window.openAdminOS.getAppState();const m=s.office.missions.find(m=>m.personaId==='${ids.chief}'&&m.handoffId);const run=s.runs.find(r=>m.runIds.includes(r.id));if(run.agentSlug!=='team-script-draft'||!run.officeContext.evidence.length)throw new Error('Missing bounded delegation or evidence');if(!m.skippedAgentSlugs.includes('team-evidence-review'))throw new Error('Chief did not skip redundant review');return {handoffs:s.office.handoffs.length,plannedTasks:m.agentSlugs,skippedTasks:m.skippedAgentSlugs,sourceReferences:run.officeContext.evidence.length};})()`,
    );
    await frame(join(outputDir, "rehearsal-delegation.png"));
    await evaluate(
      `window.openAdminOS.askOfficePersona({id:'${ids.chief}',question:'What changed and why did you draft this next step?'})`,
    );
    await wait(
      `(async()=>{const s=await window.openAdminOS.getAppState();return s.office.messages.some(m=>m.personaId==='${ids.chief}'&&m.role==='assistant'&&m.runIds.length);})()`,
    );
    await evaluate(
      `(async()=>{const s=await window.openAdminOS.getAppState();for(const f of s.office.findings.filter(f=>f.personaId==='${ids.source}'||f.personaId==='${ids.chief}'))await window.openAdminOS.reviewOfficeFinding({id:f.id,state:'acknowledged'});})()`,
    );
    await sleep(400);
    await frame(join(outputDir, "rehearsal-reviewed.png"));
    await writeFile(
      join(outputDir, "rehearsal.json"),
      JSON.stringify({ fixture: true, liveWrites: 0, ...evidence }, null, 2),
    );
  } finally {
    recording = false;
    await recordingTask;
    if (recordError) throw recordError;
  }
  // Large team navigation and presentation verification use persisted personas.
  await evaluate(
    `(async()=>{const s=await window.openAdminOS.getAppState();const p=s.office.personas[0];for(let i=s.office.personas.length;i<24;i++)await window.openAdminOS.saveOfficePersona({...p,id:undefined,name:'Rehearsal teammate '+String(i+1).padStart(2,'0'),avatar:['robot','cat','fox','owl'][i%4],color:['amber','sage','blue','lilac'][i%4],agentSlugs:['compliance-overview'],intervalMinutes:null,watch:undefined,enabled:true});})()`,
  );
  await wait(`document.querySelectorAll('.team-nav-persona').length===24`);
  await evaluate(
    `(()=>{[...document.querySelectorAll('button')].find(b=>b.textContent.startsWith('Floor 4')).click();[...document.querySelectorAll('button')].find(b=>b.textContent==='Team roster').click();})()`,
  );
  await wait(
    `document.querySelector('.scene-roster')?.textContent.includes('24')`,
  );
  const measurements = await evaluate<any>(
    `(async()=>{const times=[];let previous=performance.now();await new Promise(resolve=>{setTimeout(resolve,3000);const next=now=>{times.push(now-previous);previous=now;if(times.length<90)requestAnimationFrame(next);else resolve();};requestAnimationFrame(next);});const seats=[...document.querySelectorAll('.scene-persona-position')].map(p=>p.dataset.seat);if(new Set(seats).size!==seats.length)throw new Error('Overlapping seat reservations');const button=document.querySelector('.scene-roster button');button.focus();if(document.activeElement!==button)throw new Error('Roster focus inaccessible');return {frameSamples:times.length,medianFrameMs:times.sort((a,b)=>a-b)[Math.floor(times.length*.5)]??null,p95FrameMs:times[Math.floor(times.length*.95)]??null,jsHeapBytes:performance.memory?.usedJSHeapSize,personas:24,visibleSeats:seats.length};})()`,
  );
  await frame(join(outputDir, "office-24.png"));
  await evaluate(
    `(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.textContent==='Hide details');b.click();})()`,
  );
  await wait(`document.documentElement.hasAttribute('data-team-presentation')`);
  await evaluate(
    `(()=>{const footer=document.querySelector('footer[aria-label="Current tenant, provider, and data boundary"]');if(getComputedStyle(footer).visibility!=='hidden')throw new Error('Tenant status strip is visible during presentation');if(document.querySelector('.scene-persona-label strong').textContent.includes('Rehearsal teammate'))throw new Error('Persona names were not concealed');})()`,
  );
  await frame(join(outputDir, "office-presentation.png"));
  await evaluate(
    `(()=>{[...document.querySelectorAll('button')].find(b=>b.textContent==='Show details').click();})()`,
  );
  window.webContents.setZoomFactor(2);
  await sleep(200);
  const overflow = await evaluate<boolean>(
    `document.querySelector('.office-page').scrollWidth>document.querySelector('.office-page').clientWidth`,
  );
  if (overflow) throw new Error("Office page overflows at 200% zoom");
  await frame(join(outputDir, "office-zoom-200.png"));
  window.webContents.setZoomFactor(1);
  await window.webContents.debugger.attach("1.3");
  try {
    await window.webContents.debugger.sendCommand(
      "Emulation.setEmulatedMedia",
      {
        media: "screen",
        features: [
          { name: "prefers-reduced-motion", value: "reduce" },
          { name: "forced-colors", value: "active" },
        ],
      },
    );
    await frame(join(outputDir, "office-media-transition.png"));
    await reload();
    await wait(
      `document.querySelector('.team-office')?.dataset.motion==='off'`,
    );
    await frame(join(outputDir, "office-high-contrast.png"));
  } finally {
    window.webContents.debugger.detach();
  }
  // Reset media emulation first so reduced motion cannot mask a broken
  // visibility listener. Prove running -> hidden -> running independently.
  await reload();
  await wait(`document.querySelector('.team-office')?.dataset.motion==='on'`);
  // Electron intentionally keeps document.visibilityState visible when background
  // throttling is disabled for screenshots. Restore production behavior here.
  window.webContents.setBackgroundThrottling(true);
  window.hide();
  await wait(
    `document.hidden && document.querySelector('.team-office')?.dataset.motion==='off'`,
  );
  const hiddenMotion = await evaluate<string>(
    `document.querySelector('.team-office').dataset.motion`,
  );
  if (hiddenMotion !== "off")
    throw new Error("Hidden window kept ambient motion running");
  window.show();
  await wait(
    `!document.hidden && document.querySelector('.team-office')?.dataset.motion==='on'`,
  );
  window.webContents.setBackgroundThrottling(false);
  await writeFile(
    join(outputDir, "office-performance.json"),
    JSON.stringify(
      {
        ...measurements,
        frameSampling: measurements.frameSamples
          ? "Renderer animation-frame samples"
          : "Animation-frame samples unavailable; no FPS claim.",
        recordingFrames: frames,
        environment: `Electron on ${process.platform}; record desktop/session context separately`,
        hiddenMotion,
        resumedMotion: "on",
        zoom200Overflow: overflow,
      },
      null,
      2,
    ),
  );
  // Native fullscreen requires a real window manager, unlike CI's bare Xvfb.
  if (process.env.OPENADMINOS_OFFICE_NATIVE_VISUALS === "1")
    await runOfficeVisualChecks(window, outputDir);
}
