/** Synthetic end-to-end Office checks, invoked only by the unpackaged screenshot harness. */
import type { BrowserWindow } from "electron";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export async function runOfficeSmoke(
  window: BrowserWindow,
  outputDir: string,
): Promise<void> {
  const evaluate = <T>(code: string): Promise<T> =>
    window.webContents.executeJavaScript(code, true);
  const capture = async () => {
    // Discard Xvfb's previous compositor frame, as in captureScreenshotPng.
    window.webContents.invalidate();
    await window.webContents.capturePage();
    await new Promise((resolve) => setTimeout(resolve, 100));
    window.webContents.invalidate();
    return (await window.webContents.capturePage()).toPNG();
  };
  const wait = async (code: string) => {
    for (let attempt = 0; attempt < 350; attempt++) {
      if (await evaluate<boolean>(code)) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`Office smoke timed out: ${code}`);
  };
  await mkdir(outputDir, { recursive: true });
  await evaluate(
    `window.openAdminOS.setActiveModel("ollama", "test-smoke-local-model")`,
  );
  await evaluate(`location.hash = '/office'`);
  await wait(`Boolean(document.querySelector('.office-empty'))`);
  await evaluate(
    `Array.from(document.querySelectorAll('button')).find(b => b.textContent === 'Add persona').click()`,
  );
  await wait(`Boolean(document.querySelector('.office-editor'))`);
  await evaluate(`(() => {
    const form = document.querySelector('.office-editor');
    Array.from(form.querySelectorAll('button')).find(b => b.textContent === 'Chief of Staff').click();
  })()`);
  await evaluate(`(() => {
    const form = document.querySelector('.office-editor');
    for (const label of form.querySelectorAll('.office-agent-picker label')) {const input=label.querySelector('input');const wanted=/Compliance overview|Find inactive devices/.test(label.textContent);if (input.checked!==wanted) input.click();}
  })()`);
  await evaluate(
    `document.querySelector('.office-editor button[type="submit"]').click()`,
  );
  await wait(
    `Boolean(document.querySelector('.office-station')) && !document.querySelector('.office-editor')`,
  );
  await evaluate(
    `Array.from(document.querySelectorAll('button')).find(b => b.textContent === 'Run assignment').click()`,
  );
  await wait(
    `(async () => { const s = await window.openAdminOS.getAppState(); const m = s.office.missions[0]; if (m?.status === 'failed') throw new Error(m.error); return m?.status === 'completed'; })()`,
  );
  const result = await evaluate<{
    status: string;
    tasks: number;
    tenantPinned: boolean;
  }>(`(async () => {
    const state = await window.openAdminOS.getAppState();
    const m = state.office.missions[0];
    const runs = state.runs.filter(r => m.runIds.includes(r.id));
    if (runs.length !== 2 || runs.some(r => r.status !== 'completed' || !r.summary)) throw new Error('Expected two completed runs with summaries.');
    if (runs.some(r => r.tenantId !== m.tenantId || r.providerId !== m.providerId)) throw new Error('Run scope was not pinned.');
    const original = state.office.personas[0];
    for (const [name, avatar, color, agentSlugs] of [
      ['Policy Watcher', 'fox', 'sage', ['compliance-overview']],
      ['Device Investigator', 'owl', 'blue', ['find-inactive-devices']],
    ]) await window.openAdminOS.saveOfficePersona({ ...original, id: undefined, name, avatar, color, agentSlugs, responsibility: name === "Policy Watcher" ? "Review compliance posture and flag changes." : "Investigate inactive devices and stale inventory.", intervalMinutes: 60, enabled: true });
    return { status: m.status, tasks: runs.length, tenantPinned: true };
  })()`);
  await evaluate(`location.reload()`);
  await wait(`document.querySelectorAll('.office-station').length === 3`);
  await evaluate(`(() => {
    const links = Array.from(document.querySelectorAll('.team-nav-persona'));
    if (links.length !== 3 || links.some(link => !link.querySelector('svg'))) throw new Error('Missing sidebar persona icons.');
    links.find(link => link.textContent.includes('Policy Watcher')).click();
  })()`);
  await wait(
    `document.querySelector('.office-persona-heading h2')?.textContent === 'Policy Watcher'`,
  );
  await evaluate(`document.querySelector('.team-nav-persona').click()`);
  await wait(
    `document.querySelector('.office-persona-heading h2')?.textContent === 'Chief of Staff'`,
  );
  await evaluate(`(() => {
    if (!document.querySelector('.office-interior') || !document.querySelector('.scene-ball')) throw new Error('Office furnishings are missing.');
    const animated = document.querySelector('.scene-ball').getAnimations();
    if (!animated.some(a => a.playState === 'running' && a.effect.getTiming().iterations === Infinity)) throw new Error('Office game animation is not running.');
    Array.from(document.querySelectorAll('button')).find(b => b.textContent === 'Pause motion').click();
  })()`);
  await wait(
    `document.querySelector('.team-office')?.dataset.motion === 'off'`,
  );
  await evaluate(`(() => {
    if (document.querySelector('.scene-ball').getAnimations().some(a => a.playState === 'running')) throw new Error('Pause motion did not pause animation.');
    Array.from(document.querySelectorAll('button')).find(b => b.textContent === 'Resume motion').click();
  })()`);
  await wait(`document.querySelector('.team-office')?.dataset.motion === 'on'`);
  for (const width of [1440, 1100, 900]) {
    window.setContentSize(width, 1000);
    await new Promise((resolve) => setTimeout(resolve, 200));
    const overflow = await evaluate<boolean>(
      `document.querySelector('.office-page').scrollWidth > document.querySelector('.office-page').clientWidth`,
    );
    if (overflow) throw new Error(`Office overflow at ${width}px`);
    await writeFile(join(outputDir, `office-${width}.png`), await capture());
  }
  const idlePositions = await evaluate<string[]>(
    `Array.from(document.querySelectorAll('.scene-persona-position')).map(p => p.style.transform)`,
  );
  await wait(
    `Array.from(document.querySelectorAll('.scene-persona-position')).some((p, i) => p.style.transform !== ${JSON.stringify(idlePositions)}[i])`,
  );
  window.setContentSize(1440, 1000);
  await evaluate(
    `Array.from(document.querySelectorAll('button')).find(b => b.textContent === 'List').click()`,
  );
  await wait(`Boolean(document.querySelector('.office-list'))`);
  await writeFile(join(outputDir, "office-list.png"), await capture());
  await evaluate(
    `Array.from(document.querySelectorAll('button')).find(b => b.textContent === 'Edit').click()`,
  );
  await wait(`Boolean(document.querySelector('.office-editor'))`);
  await new Promise((resolve) => setTimeout(resolve, 400));
  // Headless Electron can hold CSS animations at their first frame. Use the
  // same finite-animation completion as the existing screenshot harness.
  await evaluate(`(() => {
    for (const animation of document.getAnimations()) {
      if (animation.effect?.getTiming().iterations !== Infinity) animation.finish();
    }
    const d = document.querySelector('[role="dialog"]');
    const bounds = d.getBoundingClientRect();
    if (getComputedStyle(d).opacity !== '1' || bounds.top < 0 || bounds.bottom > innerHeight) throw new Error('Persona editor is not visible inside the viewport.');
    const form = document.querySelector('.office-editor');
    form.scrollTop = form.scrollHeight;
    const save = form.querySelector('button[type="submit"]').getBoundingClientRect();
    if (save.bottom > bounds.bottom + 2) throw new Error('Persona save button is clipped: '+JSON.stringify({save:save.toJSON(),dialog:bounds.toJSON(),scroll:form.scrollTop,height:form.clientHeight,full:form.scrollHeight}));
    form.scrollTop = 0;
  })()`);
  await new Promise((resolve) => setTimeout(resolve, 100));
  await writeFile(join(outputDir, "office-editor.png"), await capture());
  await evaluate(
    `Array.from(document.querySelectorAll('.office-editor button')).find(b => b.textContent === 'Cancel').click()`,
  );
  await evaluate(
    `Array.from(document.querySelectorAll('button')).find(b => b.textContent === 'Stop & pause').click()`,
  );
  await wait(
    `(async () => !(await window.openAdminOS.getAppState()).office.personas[0].enabled)()`,
  );
  await writeFile(
    join(outputDir, "office-smoke.json"),
    JSON.stringify(result, null, 2),
  );
  console.log("[office-smoke] passed", JSON.stringify(result));
}
