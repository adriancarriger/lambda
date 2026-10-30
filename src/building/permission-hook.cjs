#!/usr/bin/env node
/**
 * The Engineering manager's PermissionRequest hook: every permission it would
 * be asked for is answered here, allow or deny, so nobody has to watch its
 * pane. It runs the loop through its agents and Lambda's commands; it never
 * edits code, and never commits or pushes (only `lambda ship` does).
 */
const fs = require('fs');

let data;
try {
  data = JSON.parse(fs.readFileSync('/dev/stdin', 'utf8'));
} catch {
  process.exit(0);
}

const toolName = data.tool_name || '';
const command = ((data.tool_input || {}).command || '').trim();
// Also run before every Bash call: a PermissionRequest only fires when a
// prompt would show, so auto mode or another source's allow would skip it.
const beforeTool = data.hook_event_name === 'PreToolUse';

// Before a tool, only Bash is decided here; the rest keep their settings
// and still reach the PermissionRequest answer below.
if (beforeTool && toolName !== 'Bash') {
  process.exit(0);
}

/**
 * Does the command run anything besides itself? Chaining, pipes, redirects,
 * a second line or a substitution let `lambda event x && git push` ride in on
 * an allowed prefix. Inside single quotes everything is literal, so a quoted
 * message to the dev may say "fix it; then rerun"; inside double quotes `$`
 * and backticks still run, so they count. Parentheses outside quotes count
 * too: zsh runs `=(…)` and glob qualifiers like `*(e:…:)`. An unclosed quote
 * is never safe.
 */
const runsMoreThanItself = (text) => {
  let quote = null;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (quote === "'") {
      if (char === "'") quote = null;
      continue;
    }
    if (char === '\\') {
      i += 1;
      continue;
    }
    if (char === '`' || char === '$') return true;
    if (quote === '"') {
      if (char === '"') quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (/[;&|<>()\n\r]/.test(char)) return true;
  }
  return quote !== null;
};

const answer = (decision) => {
  console.log(
    JSON.stringify({
      hookSpecificOutput: beforeTool
        ? {
            hookEventName: 'PreToolUse',
            permissionDecision: decision.behavior,
            permissionDecisionReason: decision.message,
          }
        : { hookEventName: 'PermissionRequest', decision },
    })
  );
  process.exit(0);
};

const allow = () => answer({ behavior: 'allow' });
const deny = (message) => answer({ behavior: 'deny', message });

const readOnlyTools = ['Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'Task'];
if (readOnlyTools.includes(toolName)) {
  allow();
}
// Waiting on the dev and qa.
if (toolName === 'mcp__await-pane__await_pane') {
  allow();
}
if (toolName !== 'Bash') {
  deny(
    'Only Bash and read-only tools are allowed for the Engineering manager.'
  );
}

if (runsMoreThanItself(command)) {
  deny(
    'One command at a time: no chaining, pipes, redirects or substitution outside quotes.'
  );
}
if (command.startsWith('sleep')) {
  deny('Sleep commands are not allowed. Use lambda await.');
}
if (/^git (commit|push)\b/.test(command)) {
  deny('Never commit or push: lambda ship does that, behind its verdict gate.');
}

/**
 * The words the shell passes on, quotes and escapes removed. Only called once
 * `runsMoreThanItself` has refused substitution, so nothing here expands.
 */
const shellWords = (text) => {
  const words = [];
  let word = null;
  let quote = null;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (quote === "'") {
      if (char === "'") quote = null;
      else word += char;
      continue;
    }
    if (char === '\\') {
      word = (word ?? '') + (text[i + 1] ?? '');
      i += 1;
      continue;
    }
    if (quote === '"') {
      if (char === '"') quote = null;
      else word += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      word = word ?? '';
      continue;
    }
    if (/\s/.test(char)) {
      if (word !== null) words.push(word);
      word = null;
      continue;
    }
    word = (word ?? '') + char;
  }
  if (word !== null) words.push(word);
  return words;
};

// Claude Code runs a prompt that starts with ! as a shell command, outside
// the agent's permissions: a message must never reach dev or qa that way.
// Any word the shell passes on counts, whatever its quoting or the options
// before it.
const words = shellWords(command);
if (
  words[0] === 'lambda' &&
  words[1] === 'tmux' &&
  ['dev', 'qa'].includes(words[2]) &&
  words.slice(3).some((word) => word.trim().startsWith('!'))
) {
  deny(
    'A message starting with ! runs as a shell command in that pane: send it without the !.'
  );
}

// Reads and comments on tickets, never a status change: a ticket is done
// only through lambda ship's verdict gate. Events: an added step's stage.*
// only, since ship.* and group.* mark tickets done.
const prefixes = [
  'lambda tmux dev',
  'lambda tmux qa',
  'lambda await',
  'lambda tickets get',
  'lambda tickets list',
  'lambda tickets comment',
  'lambda building',
  'lambda pod blocked',
  'lambda pod skip-ticket',
  'lambda pod step',
  'lambda pod reply',
  'lambda ship',
  // Read only: whether the ticket's base has a design system, for the
  // design check's skip. The manager runs no other `lambda design system`
  // command: those are the Dev's and the setup ticket's.
  'lambda design system changed',
];
if (
  prefixes.some(
    (prefix) => command === prefix || command.startsWith(`${prefix} `)
  ) ||
  /^lambda event stage\.[a-z]+ /.test(command)
) {
  allow();
}

deny('Not in the Engineering manager’s allow list.');
