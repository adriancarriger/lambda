import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * A pod's agents start in folders the person never opened in Claude Code: a
 * new worktree, and its manager folder inside it. Claude Code stops each at
 * its folder-trust prompt, which nobody sees. So before launching, Lambda
 * marks the folder trusted the way Claude Code's docs give for doing it by
 * hand (permissions, "What runs before you trust a folder"):
 * `projects["<path>"].hasTrustDialogAccepted` in `~/.claude.json`, where
 * `<path>` is the repository root, and a worktree's is its main checkout's.
 */

type Env = Record<string, string | undefined>;

/**
 * Claude Code's own state file: in `CLAUDE_CONFIG_DIR` when set, else home.
 * A test run never gets the account's real one: it throws.
 */
export const claudeStateFile = (
  env: Env = process.env,
  home: string = os.homedir()
): string => {
  if (env.CLAUDE_CONFIG_DIR !== undefined && env.CLAUDE_CONFIG_DIR !== '') {
    return path.join(env.CLAUDE_CONFIG_DIR, '.claude.json');
  }

  if (
    process.env.JEST_WORKER_ID !== undefined &&
    home === os.userInfo().homedir
  ) {
    throw new Error(
      'A test reached the real ~/.claude.json: give it a temp CLAUDE_CONFIG_DIR.'
    );
  }

  return path.join(home, '.claude.json');
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * The path Claude Code keys `folder`'s trust on: its main checkout's root
 * (the same for every worktree of the repo), else the folder itself.
 */
export const trustRoot = (folder: string): string => {
  const real = fs.realpathSync(folder);

  try {
    const common = execFileSync(
      'git',
      ['rev-parse', '--path-format=absolute', '--git-common-dir'],
      { cwd: real, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
    ).trim();

    return fs.realpathSync(path.dirname(common));
  } catch {
    return real;
  }
};

const readState = (file: string): Record<string, unknown> => {
  if (!fs.existsSync(file)) {
    return {};
  }

  const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));

  if (!isRecord(parsed)) {
    throw new Error(`${file} is not a JSON object.`);
  }

  return parsed;
};

/**
 * Mark `folder` trusted in Claude Code before an agent starts there. Writes
 * only when it isn't already, through a temp file and a rename, so Claude
 * Code never reads half a file; everything else in it is kept as it was.
 * Answers the key it marked.
 */
export const trustFolderForClaude = (
  folder: string,
  file: string = claudeStateFile()
): string => {
  const root = trustRoot(folder);
  const state = readState(file);
  const projects = isRecord(state.projects) ? state.projects : {};
  const project = isRecord(projects[root]) ? projects[root] : {};

  if (project.hasTrustDialogAccepted === true) {
    return root;
  }

  const next = {
    ...state,
    projects: {
      ...projects,
      [root]: { ...project, hasTrustDialogAccepted: true },
    },
  };
  const mode = fs.existsSync(file) ? fs.statSync(file).mode & 0o777 : 0o600;
  const temp = `${file}.lambda-${process.pid}`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`, { mode });
  fs.renameSync(temp, file);

  return root;
};
