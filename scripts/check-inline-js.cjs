const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const htmlPath = path.join(__dirname, '..', 'Dairy Farm Manager.html');
const html = fs.readFileSync(htmlPath, 'utf8');
const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)];

if (scripts.length === 0) {
  throw new Error('No inline script found in Dairy Farm Manager.html');
}

scripts.forEach((match, index) => {
  new vm.Script(match[1], { filename: `${htmlPath}#inline-script-${index + 1}` });
});

console.log(`Checked ${scripts.length} inline script(s).`);
