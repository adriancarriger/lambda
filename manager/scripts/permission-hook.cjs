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

function allow() {
  console.log(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
      },
    })
  );
  process.exit(0);
}

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

// Allow read-only tools — deny everything else that isn't Bash
const readOnlyTools = ['Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'Task'];
if (readOnlyTools.includes(toolName)) {
  allow();
}
if (toolName !== 'Bash') {
  deny('Only Bash and read-only tools are allowed for Manager.');
}

// Deny list
if (command.startsWith('sleep')) {
  deny('Sleep commands are not allowed.');
}

// Exact match allow list
if (command === 'touch .shutdown_confirmed') {
  allow();
}
if (command.includes('.shutdown_confirmed')) {
  deny('Use relative path: touch .shutdown_confirmed (not absolute path).');
}

// Prefix match allow list
const prefixes = [
  'lambda tmux john',
  'lambda tmux sam',
  'lambda tasks',
  'lambda ship',
];
if (prefixes.some((p) => command.startsWith(p))) {
  allow();
}

deny('Action not in allowlist. Ask Manager to add it if needed.');
