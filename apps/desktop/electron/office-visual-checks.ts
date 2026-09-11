import type { BrowserWindow } from "electron";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Native-window visual regression, using only the rehearsal's isolated fixtures. */
export async function runOfficeVisualChecks(
  window: BrowserWindow,
  output: string,
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
    for (let i = 0; i < 150; i++) {
      if (await evaluate<boolean>(code)) return;
      await sleep(100);
    }
    const details = await evaluate(
      `({text:document.querySelector('.office-page')?.innerText, errors:[...document.querySelectorAll('[role=alert]')].map(e=>e.textContent)})`,
    );
    console.error("[office-visual-timeout]", {
      code,
      fullscreen: window.isFullScreen(),
      visible: window.isVisible(),
      details,
    });
    throw new Error(`Office visual check timed out: ${code}`);
  };
  const click = async (text: string) => {
    await evaluate(
      `(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(text)});if(!b)throw new Error('Missing visual control: '+${JSON.stringify(text)});b.click();})()`,
    );
    await sleep(200);
  };
  const capture = async (name: string) => {
    await sleep(350);
    for (let i = 0; i < 4; i++) {
      window.webContents.invalidate();
      await window.webContents.capturePage();
      await sleep(80);
    }
    window.webContents.invalidate();
    await window.webContents.capturePage();
    await sleep(100);
    await writeFile(
      join(output, name + ".png"),
      (await window.webContents.capturePage()).toPNG(),
    );
  };
  const bounds = window.getBounds();
  const minimum = window.getMinimumSize();
  const measurements: unknown[] = [];
  window.setMinimumSize(800, 600);
  window.webContents.setZoomFactor(1);
  await reload();
  await wait(`Boolean(document.querySelector('.scene-persona'))`);
  await click("Pause motion");
  for (const [width, height] of [
    [1366, 768],
    [1920, 1080],
  ]) {
    window.setContentSize(width, height);
    await sleep(400);
    await capture(`office-window-${width}`);
    measurements.push(
      await evaluate(
        `(()=>{const stage=document.querySelector('.office-stage').getBoundingClientRect();return {mode:'window',width:innerWidth,height:innerHeight,stage:stage.toJSON()};})()`,
      ),
    );
  }
  await click("Expand office");
  await capture("office-expanded");
  await click("Full screen");
  await wait(`document.documentElement.hasAttribute('data-team-fullscreen')`);
  if (!window.isFullScreen())
    throw new Error(
      "Renderer fullscreen did not enter the native window mode.",
    );
  await capture("office-fullscreen");
  measurements.push(
    await evaluate(`(()=>{
    const stage=document.querySelector('.office-stage').getBoundingClientRect();
    const scope=document.querySelector('footer[aria-label="Current tenant, provider, and data boundary"]');
    const exit=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Exit full screen').getBoundingClientRect();
    if(stage.top<0||stage.bottom>innerHeight||stage.right>innerWidth)throw new Error('Fullscreen room is clipped');
    if(getComputedStyle(scope).visibility==='hidden'||getComputedStyle(scope).display==='none')throw new Error('Fullscreen concealed the tenant boundary');
    if(exit.bottom>innerHeight)throw new Error('Fullscreen exit is clipped');
    return {mode:'fullscreen',width:innerWidth,height:innerHeight,stage:stage.toJSON(),tenantBoundaryVisible:true};
  })()`),
  );
  await click("Assignment details");
  await evaluate(
    `(()=>{const rows=[...document.querySelectorAll('.office-work-order li')];if(!rows[0].textContent.includes('Skipped by assignment plan')||rows[0].querySelector('a')||!rows[1].textContent.includes('completed')||!rows[1].querySelector('a'))throw new Error('Work-order evidence is mapped to a skipped task');})()`,
  );
  await capture("office-fullscreen-details");
  await click("Close assignment");
  await click("Review inbox");
  await wait(`Boolean(document.querySelector('[role=dialog]'))`);
  window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
  window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Escape" });
  await wait(`!document.querySelector('[role=dialog]')`);
  if (!window.isFullScreen())
    throw new Error("Closing a dialog exited fullscreen.");
  await click("Hide details");
  await capture("office-fullscreen-concealed");
  await click("Show details");
  await click("Team roster");
  window.webContents.setZoomFactor(2);
  await sleep(400);
  await capture("office-fullscreen-zoom-200");
  await evaluate(`(()=>{
    const stage=document.querySelector('.office-stage').getBoundingClientRect(), viewport=document.querySelector('.scene-viewport').getBoundingClientRect();
    if(stage.width>viewport.width+2||stage.height>viewport.height+2)throw new Error('Room did not fit after 200% zoom: '+JSON.stringify({stage:stage.toJSON(),viewport:viewport.toJSON()}));
    const labels=[...document.querySelectorAll('.scene-persona-label')].filter(e=>getComputedStyle(e).opacity!=='0').map(e=>e.getBoundingClientRect());
    if(labels.length!==1)throw new Error('Expected exactly one visible selection label');
    for(let i=0;i<labels.length;i++)for(let j=i+1;j<labels.length;j++){const a=labels[i],b=labels[j];if(a.left<b.right&&a.right>b.left&&a.top<b.bottom&&a.bottom>b.top)throw new Error('Teammate labels overlap at 200%');}
    if(document.querySelectorAll('.scene-roster button').length!==6)throw new Error('Visible floor lost roster access at 200%');
  })()`);
  await evaluate(
    `document.querySelector('.scene-roster').scrollIntoView({block:'center'})`,
  );
  await capture("office-fullscreen-roster-200");
  window.webContents.setZoomFactor(1);
  await click("Hide roster");
  window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
  window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Escape" });
  await wait(`!document.documentElement.hasAttribute('data-team-fullscreen')`);
  if (window.isFullScreen())
    throw new Error("Escape did not restore the native window.");
  await wait(
    `[...document.querySelectorAll('button')].some(b=>b.textContent==='Restore layout')`,
  );
  await click("Full screen");
  await wait(`document.documentElement.hasAttribute('data-team-fullscreen')`);
  window.setFullScreen(false); // Native OS control, independent of renderer Exit button.
  await wait(`!document.documentElement.hasAttribute('data-team-fullscreen')`);
  await click("Full screen");
  await wait(`document.documentElement.hasAttribute('data-team-fullscreen')`);
  await evaluate(`location.hash='/agents'`);
  await wait(`!document.documentElement.hasAttribute('data-team-fullscreen')`);
  await sleep(500);
  if (window.isFullScreen())
    throw new Error("Route exit did not restore the window.");
  await evaluate(`location.hash='/office'`);
  await wait(`Boolean(document.querySelector('.scene-persona'))`);
  window.setBounds(bounds);
  window.setMinimumSize(minimum[0], minimum[1]);
  await writeFile(
    join(output, "office-visual-checks.json"),
    JSON.stringify(
      {
        platform: process.platform,
        fixture: true,
        nativeFullscreen: true,
        escape: true,
        nestedDialogEscape: true,
        nativeExit: true,
        routeExit: true,
        labels200: "no overlap",
        measurements,
      },
      null,
      2,
    ),
  );
}
