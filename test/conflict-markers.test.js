const fs = require('fs');
const path = require('path');

const MARKER_REGEX = /^(<{7}|={7}|>{7})/m;
const IGNORE_DIRS = new Set(['.git', 'node_modules']);
const findings = [];

function scanDir(dir){
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries){
    if (IGNORE_DIRS.has(entry.name)) continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()){
      scanDir(fullPath);
    } else {
      const content = fs.readFileSync(fullPath, 'utf8');
      const match = content.match(MARKER_REGEX);
      if (match){
        const lines = content.split(/\r?\n/);
        const lineNo = lines.findIndex(line => MARKER_REGEX.test(line)) + 1;
        findings.push({ file: fullPath, line: lineNo });
      }
    }
  }
}

scanDir(path.resolve(__dirname, '..'));

if (findings.length){
  const formatted = findings.map(f => `${path.relative(process.cwd(), f.file)}:${f.line}`).join('\n');
  throw new Error(`Merge conflict markers found:\n${formatted}`);
}

console.log('No merge conflict markers found.');
