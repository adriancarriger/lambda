import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

type Env = Record<string, string | undefined>;

/** Where Claude Code keeps conversations: one folder per project under it. */
export const claudeProjectsDir = (
  env: Env = process.env,
  home: string = os.homedir()
): string =>
  env.CLAUDE_CONFIG_DIR === undefined || env.CLAUDE_CONFIG_DIR === ''
    ? path.join(home, '.claude', 'projects')
    : path.join(env.CLAUDE_CONFIG_DIR, 'projects');

/**
 * Did Claude Code ever start this conversation? Session ids are UUIDs, so
 * it's found by name in any project's folder, never by working out the
 * folder Claude Code names for a path.
 */
export const hasConversation = (
  sessionId: string,
  dir: string = claudeProjectsDir()
): boolean => {
  if (!fs.existsSync(dir)) {
    return false;
  }

  return fs
    .readdirSync(dir)
    .some((project) =>
      fs.existsSync(path.join(dir, project, `${sessionId}.jsonl`))
    );
};

/**
 * How to start an agent: a resume only of a conversation that exists. One
 * whose first start never got going (or was never recorded) starts fresh
 * under the same id: `claude --resume` of an id it never saw just exits.
 */
export const startKind = (
  mode: 'fresh' | 'resume',
  sessionId: string,
  dir?: string
): 'fresh' | 'resume' =>
  mode === 'resume' && !hasConversation(sessionId, dir) ? 'fresh' : mode;
