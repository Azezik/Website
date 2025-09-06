const loginSection = document.getElementById('login-section');
const appSection = document.getElementById('app-section');
const loginForm = document.getElementById('login-form');
const logoutBtn = document.getElementById('logout-btn');
const fileInput = document.getElementById('file-input');
const statusEl = document.getElementById('status');
const extractedEl = document.getElementById('extracted');

function checkAuth() {
  const user = localStorage.getItem('iwUser');
  if (user) {
    loginSection.style.display = 'none';
    appSection.style.display = 'block';
  } else {
    loginSection.style.display = 'block';
    appSection.style.display = 'none';
  }
}

loginForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const username = document.getElementById('username').value.trim();
  const password = document.getElementById('password').value.trim();
  if (!username || !password) {
    alert('Please enter username and password');
    return;
  }
  localStorage.setItem('iwUser', username);
  checkAuth();
});

logoutBtn.addEventListener('click', () => {
  localStorage.removeItem('iwUser');
  checkAuth();
});

fileInput.addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  extractedEl.textContent = '';
  statusEl.textContent = 'Running OCR...';
  try {
    const { data: { text } } = await Tesseract.recognize(file, 'eng', {
      logger: (m) => {
        statusEl.textContent = m.status + ' ' + Math.round(m.progress * 100) + '%';
      },
    });
    statusEl.textContent = 'Completed';
    extractedEl.textContent = text;
    const invMatch = text.match(/invoice\s*(#:?|no.?)[\s-]*(\w+)/i);
    if (invMatch) {
      const invDiv = document.createElement('div');
      invDiv.innerHTML = `<strong>Invoice Number:</strong> ${invMatch[2]}`;
      extractedEl.prepend(invDiv);
    }
  } catch (err) {
    console.error(err);
    statusEl.textContent = 'Error: ' + err.message;
  }
});

checkAuth();
