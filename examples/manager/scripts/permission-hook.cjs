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

// A prefix only vouches for one command: anything the shell would run as a
// second one (`;`, `&&`, `|`, a redirect, `$(…)`, backticks, a new line) is
// refused, unless it sits inside single quotes, where the shell reads it as
// plain text (the messages sent to Ron and Sam; the CLI hands its arguments
// to tmux, git and gh as argument arrays, never through a shell). A backslash
// outside single quotes is refused too: `\'` is a literal quote to the shell,
// so skipping it would misread where the quoted text ends.
function chainsCommands(text) {
  let quote = null;
  for (const char of text) {
    if (quote === "'") {
      if (char === "'") quote = null;
      continue;
    }
    if (char === '\n' || char === '`' || char === '$' || char === '\\') return true;
    if (quote === '"') {
      if (char === '"') quote = null;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (';&|<>'.includes(char)) return true;
  }
  return false;
}
if (chainsCommands(command)) {
  deny('One command at a time: no ; && | redirects $( ) backticks or backslashes outside single quotes.');
}

// Prefix match allow list
const prefixes = [
  'lambda-demo tmux ron',
  'lambda-demo tmux sam',
  'lambda-demo tasks',
  'lambda-demo ship',
];
if (prefixes.some((p) => command.startsWith(p))) {
  allow();
}

deny('Action not in allowlist. Ask Manager to add it if needed.');
