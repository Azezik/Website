const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');
const pattern = new RegExp(`^${"<".repeat(7)}[^\n]*\n([\s\S]*?)\n=======\n([\s\S]*?)\n${">".repeat(7)}[^\n]*$`, 'gm');

function pickSide(file, upper, lower) {
  const basename = path.basename(file);
  const loadProfileLine = 'const existing = loadProfile(state.username, state.docType);';
  const versionText = 'Profiles include a version (currently 3). On load, migrations add any missing field types or landmark data so older profiles still work.';
  const overlayText = '.landmark-overlay';
  const overlayCss = 'pointer-events: none';

  if (basename === 'invoice-wizard.js') {
    if (upper.includes(loadProfileLine) || lower.includes(loadProfileLine)) {
      return upper.includes(loadProfileLine) ? upper : lower;
    }
  }
  if (basename === 'AGENTS.md') {
    if (upper.includes(versionText) || lower.includes(versionText)) {
      return upper.includes(versionText) ? upper : lower;
    }
  }
  if ((upper.includes(overlayText) && upper.includes(overlayCss)) ||
      (lower.includes(overlayText) && lower.includes(overlayCss))) {
    return (upper.includes(overlayText) && upper.includes(overlayCss)) ? upper : lower;
  }
  return lower;
}

function resolveFile(file) {
  const text = fs.readFileSync(file, 'utf8');
  let count = 0;
  const resolved = text.replace(pattern, (match, upper, lower) => {
    count++;
    return pickSide(file, upper, lower);
  });
  if (count > 0) {
    fs.writeFileSync(file, resolved);
  }
  return count;
}

function walk(dir, results) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === 'node_modules') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, results);
    } else {
      const blocks = resolveFile(full);
      if (blocks > 0) results.push({ file: path.relative(repoRoot, full), blocks });
    }
  }
}

function main() {
  const results = [];
  walk(repoRoot, results);
  if (results.length === 0) {
    console.log('No conflicts found');
  } else {
    for (const r of results) {
      console.log(`${r.file}: resolved ${r.blocks} blocks`);
    }
  }
}

if (require.main === module) {
  main();
}
