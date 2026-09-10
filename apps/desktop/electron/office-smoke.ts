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
    for (let attempt = 0; attempt < 200; attempt++) {
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
    Array.from(form.querySelectorAll('.office-agent-picker label')).find(l => l.textContent.includes('Compliance overview')).querySelector('input').click();
    Array.from(form.querySelectorAll('.office-agent-picker label')).find(l => l.textContent.includes('Find inactive devices')).querySelector('input').click();
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
  for (const width of [1440, 1100, 900]) {
    window.setContentSize(width, 1000);
    await new Promise((resolve) => setTimeout(resolve, 200));
    const overflow = await evaluate<boolean>(
      `document.querySelector('.office-page').scrollWidth > document.querySelector('.office-page').clientWidth`,
    );
    if (overflow) throw new Error(`Office overflow at ${width}px`);
    await writeFile(join(outputDir, `office-${width}.png`), await capture());
  }
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
    form.querySelector('button[type="submit"]').scrollIntoView({ block: 'nearest' });
    const save = form.querySelector('button[type="submit"]').getBoundingClientRect();
    if (save.bottom > bounds.bottom) throw new Error('Persona save button is clipped.');
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
