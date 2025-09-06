const loginSection = document.getElementById('login-section');
const dashboard = document.getElementById('dashboard');
const loginForm = document.getElementById('login-form');
const logoutBtn = document.getElementById('logout-btn');
const uploadBtn = document.getElementById('upload-btn');
const configureBtn = document.getElementById('configure-btn');
const demoBtn = document.getElementById('demo-btn');
const newWizardBtn = document.getElementById('new-wizard-btn');
const dropzone = document.getElementById('dropzone');
const fileInput = document.getElementById('file-input');

let users = JSON.parse(localStorage.getItem('iwUsers') || '{}');
let currentUser = null;

function saveUsers(){
  localStorage.setItem('iwUsers', JSON.stringify(users));
}

function checkAuth(){
  const session = localStorage.getItem('iwSession');
  if(session && users[session]){
    currentUser = session;
    loginSection.style.display = 'none';
    dashboard.style.display = 'block';
    renderDashboard();
  } else {
    loginSection.style.display = 'block';
    dashboard.style.display = 'none';
  }
}

function renderDashboard(){
  const user = users[currentUser];
  if(user.schemaConfigured){
    uploadBtn.style.display = 'inline-block';
    newWizardBtn.style.display = 'inline-block';
    configureBtn.style.display = 'none';
    demoBtn.style.display = 'none';
  } else {
    uploadBtn.style.display = 'none';
    configureBtn.style.display = 'inline-block';
    demoBtn.style.display = 'inline-block';
    newWizardBtn.style.display = 'none';
  }
}

loginForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const username = document.getElementById('username').value.trim();
  const password = document.getElementById('password').value.trim();
  if(!username || !password){
    alert('Please enter username and password');
    return;
  }
  if(!users[username]){
    users[username] = { password, schemaConfigured:false };
    saveUsers();
  }
  localStorage.setItem('iwSession', username);
  checkAuth();
});

logoutBtn.addEventListener('click', () => {
  localStorage.removeItem('iwSession');
  currentUser = null;
  checkAuth();
});

configureBtn.addEventListener('click', () => {
  users[currentUser].schemaConfigured = true;
  saveUsers();
  window.location.href = 'wizard-config.html';
});

newWizardBtn.addEventListener('click', () => {
  window.location.href = 'wizard-config.html';
});

demoBtn.addEventListener('click', () => {
  alert('Demo wizard coming soon.');
});

uploadBtn.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', (e) => {
  alert(e.target.files.length + ' file(s) selected (upload not yet implemented).');
});

['dragover','dragleave','drop'].forEach(evt => {
  dropzone.addEventListener(evt, (e) => {
    e.preventDefault();
    if(evt === 'dragover') dropzone.classList.add('dragover');
    if(evt === 'dragleave') dropzone.classList.remove('dragover');
    if(evt === 'drop'){
      dropzone.classList.remove('dragover');
      const files = Array.from(e.dataTransfer.files);
      if(files.length) alert(files.length + ' file(s) dropped (upload not yet implemented).');
    }
  });
});

checkAuth();
