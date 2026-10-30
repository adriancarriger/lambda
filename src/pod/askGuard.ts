import { ASK_FORK_ALLOW, PRODUCT_MANAGER_ALLOW } from './launch';

/**
 * The ask fork's PreToolUse guard (`lambda pod hook ask-guard`). Settings
 * from other sources merge into a fork's (the person's own allow list, their
 * default mode), and an allow there could let a fork type into the real
 * dev's pane. A hook's deny beats every allow, so the fork's own read-only
 * list is enforced here: anything else, or a command that chains another
 * after an allowed one, is refused.
 */

const toolsOf = (rules: string[]): string[] =>
  rules.filter((rule) => !rule.startsWith('Bash('));

const commandsOf = (rules: string[]): string[] =>
  rules.flatMap((rule) => {
    const match = /^Bash\((.+):\*\)$/.exec(rule);

    return match?.[1] === undefined ? [] : [match[1]];
  });

const TOOLS = toolsOf(ASK_FORK_ALLOW);

const COMMANDS = commandsOf(ASK_FORK_ALLOW);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

/**
 * Chaining, substitution, redirection or a second line: never read-only.
 * Parentheses too: zsh runs a command from `=(…)` and from a glob qualifier
 * such as `*(e:…:)`.
 */
const SHELL_SYNTAX = /[;&|`$<>()\n\r]/;

/**
 * Options that make an allowed command write or run something: git's
 * `--output` writes a file, rg's `--pre` runs a program on every file and
 * `--hostname-bin` runs one for the hostname.
 */
const WRITE_OPTIONS = [
  /(^|\s)--output(=|\s|$)/,
  /(^|\s)--pre(=|\s|$)/,
  /(^|\s)--hostname-bin(=|\s|$)/,
];

/** Checked with quotes and backslashes gone, as the shell would pass it. */
const writes = (command: string): boolean => {
  const unquoted = command.replace(/["'\\]/g, '');

  return WRITE_OPTIONS.some((option) => option.test(unquoted));
};

const startsWithOneOf = (command: string, prefixes: string[]): boolean =>
  prefixes.some(
    (prefix) => command === prefix || command.startsWith(`${prefix} `)
  );

const isReadOnlyCommand = (command: string): boolean => {
  const trimmed = command.trim();

  return (
    !SHELL_SYNTAX.test(trimmed) &&
    !writes(trimmed) &&
    startsWithOneOf(trimmed, COMMANDS)
  );
};

export const askGuardDecision = (
  tool: string,
  input: Record<string, unknown>
): 'allow' | 'deny' => {
  if (TOOLS.includes(tool)) {
    return 'allow';
  }

  return tool === 'Bash' &&
    typeof input.command === 'string' &&
    isReadOnlyCommand(input.command)
    ? 'allow'
    : 'deny';
};

/**
 * Does the command run anything besides itself? The Product manager answers
 * in markdown, so a quoted message may hold `;`, `|` or a second line; only
 * what the shell would act on counts: chaining, pipes or redirects outside
 * quotes, and `$` or a backtick outside single quotes. Parentheses outside
 * quotes count too: zsh runs `=(…)` and glob qualifiers like `*(e:…:)`. An
 * unclosed quote is never safe.
 */
const runsMoreThanItself = (text: string): boolean => {
  const scan = (at: number, quote: string | null): boolean => {
    if (at >= text.length) {
      return quote !== null;
    }
    const char = text.charAt(at);

    if (quote === "'") {
      return scan(at + 1, char === "'" ? null : quote);
    }

    if (char === '\\') {
      return scan(at + 2, quote);
    }

    if (char === '`' || char === '$') {
      return true;
    }

    if (quote === '"') {
      return scan(at + 1, char === '"' ? null : quote);
    }

    if (char === '"' || char === "'") {
      return scan(at + 1, char);
    }

    return /[;&|<>()\n\r]/.test(char) || scan(at + 1, null);
  };

  return scan(0, null);
};

/**
 * The one multi-line form the Product manager's instructions give it:
 * `lambda pod reply --fyi "$(cat <<'EOF' … EOF)"`. A quoted `'EOF'` turns
 * expansion off, so the body is literal, as long as no line of it ends the
 * heredoc early: bash ends it on any line starting `EOF`, `EOF)` included.
 * What's left after the body is checked like any command.
 */
const HEREDOC_ARGUMENT = /^([^\n]*) "\$\(cat <<'EOF'\n([\s\S]*)\nEOF\n?\)"$/;

const withoutLiteralHeredoc = (command: string): string => {
  const match = HEREDOC_ARGUMENT.exec(command);
  const head = match?.[1];
  const body = match?.[2];

  return head === undefined || body === undefined || /(^|\n)EOF/.test(body)
    ? command
    : head;
};

const PM_TOOLS = toolsOf(PRODUCT_MANAGER_ALLOW);

const PM_COMMANDS = commandsOf(PRODUCT_MANAGER_ALLOW);

/**
 * Their argument is the Product manager's own message, which may well
 * mention `--pre` or `--output`: the write-option check doesn't apply.
 */
const PM_MESSAGE_COMMANDS = [
  'lambda pod reply',
  'lambda pod ask',
  'lambda pod relay',
];

const isProductManagerCommand = (command: string): boolean => {
  const trimmed = withoutLiteralHeredoc(command.trim());

  return (
    !runsMoreThanItself(trimmed) &&
    (startsWithOneOf(trimmed, PM_MESSAGE_COMMANDS) || !writes(trimmed)) &&
    startsWithOneOf(trimmed, PM_COMMANDS)
  );
};

/**
 * The Product manager's PreToolUse guard (`lambda pod hook pm-guard`): it
 * reads everything and changes nothing, so its allow list is all it may do,
 * whatever other settings sources allow.
 */
export const productManagerGuardDecision = (
  tool: string,
  input: Record<string, unknown>
): 'allow' | 'deny' => {
  if (PM_TOOLS.includes(tool)) {
    return 'allow';
  }

  return tool === 'Bash' &&
    typeof input.command === 'string' &&
    isProductManagerCommand(input.command)
    ? 'allow'
    : 'deny';
};

const guardAnswer = (
  raw: string,
  decide: (tool: string, input: Record<string, unknown>) => 'allow' | 'deny',
  reason: string
): string => {
  const event: unknown = (() => {
    try {
      return JSON.parse(raw);
    } catch {
      return {};
    }
  })();
  const record = isRecord(event) ? event : {};
  const tool = typeof record.tool_name === 'string' ? record.tool_name : '';
  const input = isRecord(record.tool_input) ? record.tool_input : {};
  const decision = decide(tool, input);

  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: decision,
      ...(decision === 'deny' ? { permissionDecisionReason: reason } : {}),
    },
  });
};

/** The hook's answer to one PreToolUse event, as Claude Code reads it. */
export const askGuardAnswer = (raw: string): string =>
  guardAnswer(
    raw,
    askGuardDecision,
    'This is a read-only fork: it can only read files and run read-only git and file commands.'
  );

/** The Product manager's answer to one PreToolUse event. */
export const productManagerGuardAnswer = (raw: string): string =>
  guardAnswer(
    raw,
    productManagerGuardDecision,
    'The Product manager reads everything and changes nothing: ask, peek, relay or reply, one command at a time.'
  );
