#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

let data;
try {
  const input = fs.readFileSync('/dev/stdin', 'utf8');
  data = JSON.parse(input);
} catch {
  process.exit(0);
}

const toolName = data.tool_name || '';
const command = (data.tool_input || {}).command || '';
const cwd = data.cwd || '';

function deny(message) {
  console.log(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: message,
      },
    })
  );
  process.exit(0);
}

// Manager runs from manager/ — don't block it
const managerDir = path.resolve(__dirname, '..', '..', 'manager');
const resolvedCwd = path.resolve(cwd);
if (resolvedCwd === managerDir || resolvedCwd.startsWith(managerDir + path.sep)) {
  process.exit(0);
}

// Only inspect Bash commands
if (toolName !== 'Bash') {
  process.exit(0);
}

// Block git push, git commit, and lambda-demo ship — reserved for Manager
if (/\bgit\b.*\bpush\b/.test(command)) {
  deny('git push is reserved for the Manager via lambda-demo ship.');
}
if (/\bgit\b.*\bcommit\b/.test(command)) {
  deny('git commit is reserved for the Manager via lambda-demo ship.');
}
if (command.includes('lambda-demo ship')) {
  deny('lambda-demo ship is reserved for the Manager. Dev must never ship directly.');
}
