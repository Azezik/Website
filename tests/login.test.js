const { test } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const engine = require('../invoice-wizard.js');

test('login toggles visibility and persists user', () => {
  const dom = new JSDOM(`
    <section id="login-section">
      <form id="login-form">
        <input id="username" />
        <input id="password" type="password" />
      </form>
    </section>
    <section id="app" style="display:none">
      <button id="logout-btn"></button>
    </section>
  `, { url: 'http://localhost' });

  global.window = dom.window;
  global.document = dom.window.document;
  global.localStorage = dom.window.localStorage;

  engine.initLogin();

  const form = document.getElementById('login-form');
  document.getElementById('username').value = 'alice';
  document.getElementById('password').value = 'secret';
  form.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));

  assert.equal(document.getElementById('login-section').style.display, 'none');
  assert.equal(document.getElementById('app').style.display, 'block');
  assert.equal(localStorage.getItem('iwUser'), 'alice');

  const logout = document.getElementById('logout-btn');
  logout.click();
  assert.equal(document.getElementById('app').style.display, 'none');
  assert.equal(document.getElementById('login-section').style.display, 'block');

  delete global.window;
  delete global.document;
  delete global.localStorage;
});
