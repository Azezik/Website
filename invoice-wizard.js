/* =========================
   Invoice Wizard — WROKIT
   Front-end only (static site)
   - Login (demo mode)
   - Dashboard
   - Wizard highlighter (PDF/image + overlay)
   - Stepper saves normalized bboxes to localStorage
   ========================= */

//// DOM refs
const loginSection = document.getElementById('login-section');
const dashboard    = document.getElementById('dashboard');
const wizardSec    = document.getElementById('wizard-section');

// Login
const loginForm    = document.getElementById('login-form');
const logoutBtn    = document.getElementById('logout-btn');

// Dashboard controls
const docTypeSel   = document.getElementById('doc-type');
const dropzone     = document.getElementById('dropzone');
const fileInput    = document.getElementById('file-input');
const uploadBtn    = document.getElementById('upload-btn');     // disabled until schema exists (future)
const configureBtn = document.getElementById('configure-btn');
const demoBtn      = document.getElementById('demo-btn');
const newWizardBtn = document.getElementById('new-wizard-btn');

// Wizard controls
const wizardFile   = document.getElementById('wizard-file');
const stepLabel    = document.getElementById('stepLabel');
const questionText = document.getElementById('questionText');

const viewer       = document.getElementById('viewer');
const pdfCanvas    = document.getElementById('pdfCanvas');
const imgCanvas    = document.getElementById('imgCanvas');
const overlay      = document.getElementById('overlayCanvas');

const boxModeBtn         = document.getElementById('boxModeBtn');
const clearSelectionBtn  = document.getElementById('clearSelectionBtn');
const backBtn            = document.getElementById('backBtn');
const skipBtn            = document.getElementById('skipBtn');
const confirmBtn         = document.getElementById('confirmBtn');

const savedJsonEl        = document.getElementById('savedJson');
const exportBtn          = document.getElementById('exportBtn');
const finishWizardBtn    = document.getElementById('finishWizardBtn');

//// Session & schema state
let session = { username: null };
let currentMap = null;   // {username, docType, version, fields: [...]}
let stepIndex = 0;

const STEPS = [
  { key: 'order_number',       prompt: 'Please highlight the order/invoice number.' },
  { key: 'customer_name',      prompt: 'Please highlight the customer/company name.' },
  { key: 'invoice_date',       prompt: 'Please highlight the invoice date.' },
  { key: 'due_date',           prompt: 'Please highlight the payment due date.' },
  { key: 'line_item.name',     prompt: 'Highlight the product/service NAME column.' },
  { key: 'line_item.quantity', prompt: 'Highlight the QUANTITY column.' },
  { key: 'line_item.unit_price', prompt: 'Highlight the UNIT PRICE column.' },
  { key: 'line_item.total',    prompt: 'Highlight the LINE TOTAL column.' },
  { key: 'subtotal',           prompt: 'Highlight the SUBTOTAL amount.' },
  { key: 'tax_total',          prompt: 'Highlight the TAX amount(s).' },
  { key: 'grand_total',        prompt: 'Highlight the GRAND TOTAL.' },
  { key: 'payment_terms',      prompt: 'Highlight PAYMENT TERMS / notes (optional).' },
  { key: 'vendor_info',        prompt: 'Highlight VENDOR NAME & ADDRESS (optional).' }
];

//// Document render state
let docState = {
  type: 'invoice',
  pageIndex: 0,
  displayWidth: 0,
  displayHeight: 0,
  // drawing
  drawing: false,
  start: null,
  box: null
};

//// Helpers
const storageKey = (u, dt) => `wiz:${u}:${dt}:schema`;
const getDocType = () => (docTypeSel?.value || 'invoice');

function saveSchema() {
  if (!currentMap) return;
  const key = storageKey(session.username, currentMap.docType);
  localStorage.setItem(key, JSON.stringify(currentMap, null, 2));
  savedJsonEl.textContent = JSON.stringify(currentMap, null, 2);
}

function loadSchema(username, docType) {
  const key = storageKey(username, docType);
  const raw = localStorage.getItem(key);
  return raw ? JSON.parse(raw) : null;
}

function show(el)  { el.style.display = ''; }
function hide(el)  { el.style.display = 'none'; }

function enterDashboard() {
  hide(loginSection);
  show(dashboard);
  hide(wizardSec);

  // If a schema exists for selected docType, show Upload/New Wizard; else show Configure/Demo
  const existing = loadSchema(session.username, getDocType());
  if (existing && existing.fields?.length) {
    show(uploadBtn);
    show(newWizardBtn);
    hide(configureBtn);
  } else {
    hide(uploadBtn);
    hide(newWizardBtn);
    show(configureBtn);
  }
  show(demoBtn); // keep demo visible
}

function enterWizard(startFresh = false) {
  hide(loginSection);
  hide(dashboard);
  show(wizardSec);

  // initialize map
  const dt = getDocType();
  const saved = startFresh ? null : loadSchema(session.username, dt);
  currentMap = saved ?? { username: session.username, docType: dt, version: 1, fields: [] };
  stepIndex = Math.min(currentMap.fields.length, STEPS.length - 1); // continue if partially done
  updatePrompt();
  savedJsonEl.textContent = JSON.stringify(currentMap, null, 2);

  // clear viewer
  clearCanvasOverlay();
  pdfCanvas.width = pdfCanvas.height = 0;
  imgCanvas.style.display = 'none';
}

function updatePrompt() {
  stepLabel.textContent = `Step ${Math.min(stepIndex + 1, STEPS.length)}/${STEPS.length}`;
  const done = stepIndex >= STEPS.length;
  questionText.textContent = done ? 'Wizard complete. Export or finish.' : STEPS[stepIndex].prompt;
  confirmBtn.disabled = false;
}

function normalizeBox(box) {
  return [
    box.x / docState.displayWidth,
    box.y / docState.displayHeight,
    box.w / docState.displayWidth,
    box.h / docState.displayHeight
  ];
}

function denormalizeBox(bbox) {
  const [xN, yN, wN, hN] = bbox;
  return {
    x: xN * docState.displayWidth,
    y: yN * docState.displayHeight,
    w: wN * docState.displayWidth,
    h: hN * docState.displayHeight
  };
}

//// Login flow
loginForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const u = document.getElementById('username').value.trim();
  const p = document.getElementById('password').value.trim();
  if (!u || !p) { alert('Please enter username and password.'); return; }
  session.username = u;
  localStorage.setItem('iwUser', u);
  enterDashboard();
});

logoutBtn.addEventListener('click', () => {
  localStorage.removeItem('iwUser');
  session.username = null;
  show(loginSection);
  hide(dashboard);
  hide(wizardSec);
});

//// Dashboard actions
configureBtn.addEventListener('click', () => enterWizard(false));
newWizardBtn.addEventListener('click', () => enterWizard(true));
demoBtn.addEventListener('click', () => {
  // Opens wizard; user can click and load their own file
  enterWizard(false);
  alert('Load a PDF/JPG/PNG of an invoice, then highlight fields step by step.');
});

// (Upload documents later; disabled for static MVP)
uploadBtn.addEventListener('click', () => {
  alert('Upload/extraction will use your saved schema in a later iteration.');
});

docTypeSel?.addEventListener('change', () => {
  // Refresh dashboard buttons visibility when switching types
  if (!session.username) return;
  enterDashboard();
});

// Drag & drop visual only (kept for parity)
['dragover','dragleave','drop'].forEach(evt => {
  dropzone.addEventListener(evt, (e) => {
    e.preventDefault();
    if (evt === 'dragover')  dropzone.classList.add('dragover');
    if (evt === 'dragleave') dropzone.classList.remove('dragover');
    if (evt === 'drop') {
      dropzone.classList.remove('dragover');
      const files = Array.from(e.dataTransfer.files || []);
      if (files.length) alert(`${files.length} file(s) dropped. Use "Configure Wizard" to map fields.`);
    }
  });
});

//// Wizard: load document (PDF/image)
wizardFile.addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  await renderDocument(file);
  // Reset drawing state
  docState.box = null; clearCanvasOverlay();
});

async function renderDocument(file) {
  const isPdf = /pdf$/i.test(file.type);
  pdfCanvas.style.display = isPdf ? '' : 'none';
  imgCanvas.style.display = isPdf ? 'none' : '';

  if (isPdf) {
    const arrayBuf = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: arrayBuf }).promise;
    const page = await pdf.getPage(1);
    // Fit to viewer width
    const containerWidth = Math.min(1000, viewer.clientWidth || 1000);
    const viewport = page.getViewport({ scale: 1 });
    const scale = containerWidth / viewport.width;
    const scaledVp = page.getViewport({ scale });

    pdfCanvas.width  = Math.floor(scaledVp.width);
    pdfCanvas.height = Math.floor(scaledVp.height);
    const ctx = pdfCanvas.getContext('2d');
    await page.render({ canvasContext: ctx, viewport: scaledVp }).promise;

    syncOverlaySize(pdfCanvas);
  } else {
    await new Promise((resolve) => {
      imgCanvas.onload = resolve;
      imgCanvas.src = URL.createObjectURL(file);
    });
    // Ensure image fits container
    imgCanvas.style.maxWidth = '100%';
    imgCanvas.style.height = 'auto';
    syncOverlaySize(imgCanvas);
  }
}

function syncOverlaySize(baseEl) {
  // Position overlay absolutely over the shown doc
  const rect = baseEl.getBoundingClientRect();
  // Use offsetWidth/Height for actual drawn size
  const w = baseEl.clientWidth || rect.width;
  const h = baseEl.clientHeight || rect.height;

  overlay.width  = w;
  overlay.height = h;

  overlay.style.position = 'absolute';
  overlay.style.left = baseEl.offsetLeft + 'px';
  overlay.style.top  = baseEl.offsetTop  + 'px';

  viewer.style.position = 'relative';
  docState.displayWidth  = w;
  docState.displayHeight = h;
}

//// Overlay drawing (Box Mode)
const octx = overlay.getContext('2d');

function clearCanvasOverlay() {
  octx.clearRect(0,0,overlay.width,overlay.height);
}

overlay.addEventListener('mousedown', (e) => {
  const p = rel(e);
  docState.drawing = true;
  docState.start = p;
  docState.box = null;
  drawTempBox(); // clears
});

overlay.addEventListener('mousemove', (e) => {
  if (!docState.drawing) return;
  const p = rel(e);
  const nb = normBox(docState.start.x, docState.start.y, p.x - docState.start.x, p.y - docState.start.y);
  docState.box = nb;
  drawTempBox();
});

overlay.addEventListener('mouseup', () => {
  docState.drawing = false;
});

function rel(e) {
  const r = overlay.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}

function normBox(x, y, w, h) {
  if (w < 0) { x += w; w = -w; }
  if (h < 0) { y += h;
