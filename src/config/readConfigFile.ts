import * as fs from 'fs';
import * as path from 'path';
import { type z } from 'zod';

/**
 * Read and validate a JSON settings file. Throws an Error naming the file and
 * every field at fault, one line each, so a project owner can fix them all
 * without reading docs: `lambda.json: tickets.statuses.blocked has no name for
 * "blocked".` A file that isn't JSON: `Invalid JSON in <path>: <parse error>`.
 */
export const readConfigFile = <T>(
  file: string,
  schema: z.ZodType<T, z.ZodTypeDef, unknown>
): T => {
  const text = fs.readFileSync(file, 'utf8');
  const json = parseJson(file, text);
  const result = schema.safeParse(json);

  if (result.success) {
    return result.data;
  }

  const where = displayPath(file);
  const lines = result.error.issues.map(
    (issue) => `${where}: ${fieldOf(issue)} ${describeIssue(issue)}`
  );

  throw new Error(lines.length === 0 ? `${where}: invalid` : lines.join('\n'));
};

/** Relative to where the command runs when it's inside, else the full path. */
const displayPath = (file: string): string => {
  const relative = path.relative(process.cwd(), file);

  return relative === '' ||
    relative.startsWith('..') ||
    path.isAbsolute(relative)
    ? file
    : relative;
};

const fieldOf = (issue: z.ZodIssue): string =>
  issue.path.length === 0 ? '(root)' : issue.path.join('.');

/**
 * Lambda's own messages already read on from the field name (`has no name
 * for…`, `"trello" isn't one of…`); zod's built-in ones start with a capital
 * (`Expected string, received number`), so they're lower-cased to match.
 */
const describeIssue = (issue: z.ZodIssue): string => {
  if (issue.code === 'invalid_type' && issue.received === 'undefined') {
    return 'is required.';
  }

  return issue.message.charAt(0).toLowerCase() + issue.message.slice(1);
};

const parseJson = (file: string, text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`Invalid JSON in ${file}: ${describeParseError(error)}`);
  }
};

/**
 * Where the JSON broke, without V8's message: it quotes the text around the
 * error, and the machine file holds tokens.
 */
const describeParseError = (error: unknown): string => {
  const message = error instanceof Error ? error.message : String(error);
  const location = /\(line (\d+) column (\d+)\)/.exec(message);

  if (location !== null) {
    return `line ${location[1]} column ${location[2]}`;
  }

  if (message.startsWith('Unexpected end of JSON input')) {
    return 'unexpected end of input';
  }

  if (message.startsWith('Unexpected token')) {
    return 'unexpected token';
  }

  return 'not valid JSON';
};
