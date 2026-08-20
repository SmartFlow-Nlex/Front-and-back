const fs = require('fs');
const path = require('path');

function searchDir(dir, pattern) {
  const files = fs.readdirSync(dir);
  for (const file of files) {
    if (file === 'node_modules' || file === '.next' || file === '.git') continue;
    const fullPath = path.join(dir, file);
    const stat = fs.statSync(fullPath);
    if (stat.isDirectory()) {
      searchDir(fullPath, pattern);
    } else if (file.endsWith('.ts') || file.endsWith('.tsx') || file.endsWith('.js') || file.endsWith('.json')) {
      const content = fs.readFileSync(fullPath, 'utf8');
      if (pattern.test(content)) {
        console.log(`Match in: ${fullPath}`);
        const lines = content.split('\n');
        lines.forEach((line, idx) => {
          if (pattern.test(line)) {
            console.log(`  L${idx+1}: ${line.trim()}`);
          }
        });
      }
    }
  }
}

const root = 'C:\\Users\\Hans\\.gemini\\antigravity\\scratch\\Front-and-back-Ver1-Merged-BE-FE\\Front-and-back-Ver1-Merged-BE-FE';
console.log('Searching for nlex_exits...');
searchDir(root, /nlex_exits/i);
console.log('\nSearching for exit_id...');
searchDir(root, /exit_id/i);
