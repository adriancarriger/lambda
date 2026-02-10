#!/usr/bin/env node
const fs = require('fs');

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
if (cwd.includes('manager')) {
  process.exit(0);
}

// Only inspect Bash commands
if (toolName !== 'Bash') {
  process.exit(0);
}

// Block git push, git commit, and lambda ship — reserved for Manager
if (/\bgit\s+push\b/.test(command)) {
  deny('git push is reserved for the Manager via lambda ship.');
}
if (/\bgit\s+commit\b/.test(command)) {
  deny('git commit is reserved for the Manager via lambda ship.');
}
if (command.includes('lambda ship')) {
  deny('lambda ship is reserved for the Manager. Dev must never ship directly.');
}
