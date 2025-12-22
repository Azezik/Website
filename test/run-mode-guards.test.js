const assert = require('assert');
const { createModeController, WizardMode } = require('../tools/wizard-mode.js');

async function main(){
  const warnings = [];
  const controller = createModeController({ warn: (msg)=>warnings.push(msg) });

  controller.setMode(WizardMode.RUN);
  let overlayExecuted = false;
  function overlayFn(){
    if(controller.guardInteractive('overlay.draw')) return;
    overlayExecuted = true;
  }

  let overlayAllowedExecuted = false;
  function overlayAllowedFn(){
    if(controller.guardInteractive('overlay.draw', { allowInRun: true })) return;
    overlayAllowedExecuted = true;
  }

  overlayFn();
  assert.strictEqual(overlayExecuted, false, 'overlay should be blocked in RUN mode');
  assert.ok(warnings.some(w => w.includes('overlay.draw')), 'warning should be emitted for overlay in RUN');

  overlayAllowedFn();
  assert.strictEqual(overlayAllowedExecuted, true, 'allowInRun should bypass guard');

  let runs = 0;
  let release;
  const first = controller.trackRun('fileA', () => new Promise(res => { release = () => { runs += 1; res(); }; }));
  const second = controller.trackRun('fileA', ()=>{ runs += 1; });
  assert.strictEqual(runs, 0, 'work should not run until released');
  release();
  await first;
  await second;
  assert.strictEqual(runs, 1, 'trackRun should block concurrent duplicates');

  controller.setMode(WizardMode.CONFIG);
  overlayExecuted = false;
  warnings.length = 0;
  overlayFn();
  assert.strictEqual(overlayExecuted, true, 'overlay should proceed in CONFIG mode');
  assert.strictEqual(warnings.length, 0, 'no warnings expected in CONFIG mode');

  console.log('Run mode guard tests passed.');
}

main();
