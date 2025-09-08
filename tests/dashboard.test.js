const { test } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const engine = require('../invoice-wizard.js');

test('dashboard buttons switch views', () => {
  const dom = new JSDOM(`
    <section id="login-section">
      <form id="login-form">
        <input id="username" />
        <input id="password" type="password" />
      </form>
    </section>
    <section id="app" style="display:none">
      <nav id="dashTabs">
        <button class="tablink active" data-target="document-dashboard">Document Dashboard</button>
        <button class="tablink" data-target="reports">Reports</button>
      </nav>
      <section id="document-dashboard" style="display:block">
        <div class="actions">
          <button id="configure-btn" type="button"></button>
        </div>
      </section>
      <section id="reports" style="display:none"></section>
    </section>
    <section id="wizard-section" style="display:none">
      <button id="finishWizardBtn" type="button"></button>
      <button id="backBtn" type="button"></button>
    </section>
  `, { url: 'http://localhost' });

  global.window = dom.window;
  global.document = dom.window.document;
  global.localStorage = dom.window.localStorage;

  engine.initLogin();

  // simulate login
  document.getElementById('username').value = 'alice';
  document.getElementById('password').value = 'pw';
  document.getElementById('login-form').dispatchEvent(new dom.window.Event('submit', { bubbles:true, cancelable:true }));

  // dashboard tab switch
  document.querySelector('#dashTabs .tablink[data-target="reports"]').click();
  assert.equal(document.getElementById('reports').style.display, 'block');
  assert.equal(document.getElementById('document-dashboard').style.display, 'none');

  // configure wizard
  document.getElementById('configure-btn').click();
  assert.equal(document.getElementById('app').style.display, 'none');
  assert.equal(document.getElementById('wizard-section').style.display, 'block');

  // return
  document.getElementById('finishWizardBtn').click();
  assert.equal(document.getElementById('wizard-section').style.display, 'none');
  assert.equal(document.getElementById('app').style.display, 'block');

  delete global.window;
  delete global.document;
  delete global.localStorage;
});
