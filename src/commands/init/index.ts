/**
 * Init command - Write lambda.json for the project in the current folder.
 *
 * Every value it writes says where it came from, and anything it couldn't
 * work out is listed under "Couldn't tell" rather than guessed.
 */
import { execFileSync } from 'child_process';
import { Command } from 'commander';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  machineConfigPath,
  writeMachineConfig,
} from '../../config/machineConfig';
import {
  LAMBDA_GITIGNORE,
  PROJECT_CONFIG_FILE,
  TASKS_FILE,
} from '../../config/projectConfig';
import { markProject } from '../../setup/firstRun';
import { findPlaywrightDir } from '../e2e';

export const LAMBDA_GITIGNORE_LINES = [
  'pods/',
  'pulled/',
  'events.jsonl',
  'agent-log.jsonl',
];

const INSTRUCTION_FILES = ['CLAUDE.md', 'AGENTS.md'];

/** Framework → its dev server's default port. */
const FRAMEWORK_PORTS = [
  { dependency: 'next', name: 'Next.js', port: 3000 },
  { dependency: 'vite', name: 'Vite', port: 5173 },
];

export interface InitOptions {
  cwd: string;
  force?: boolean;
  dryRun?: boolean;
  name?: string;
  email?: string;
  env?: NodeJS.ProcessEnv;
}

export interface InitResult {
  code: number;
  /** Lines for stdout. */
  output: string[];
  /** Printed to stderr when set. */
  error?: string;
}

interface Found {
  key: string;
  value: string;
  source?: string;
}

interface Unknown {
  key: string;
  note: string;
}

interface PackageJson {
  name?: string;
  scripts: Record<string, string>;
  dependencies: Record<string, string>;
  bin: string | Record<string, string> | undefined;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const stringRecord = (value: unknown): Record<string, string> =>
  isRecord(value)
    ? Object.fromEntries(
        Object.entries(value).filter(
          (entry): entry is [string, string] => typeof entry[1] === 'string'
        )
      )
    : {};

/** The project's package.json, or undefined when it's missing or unreadable. */
const readPackageJson = (cwd: string): PackageJson | undefined => {
  try {
    const json: unknown = JSON.parse(
      fs.readFileSync(path.join(cwd, 'package.json'), 'utf8')
    );

    if (!isRecord(json)) {
      return undefined;
    }

    return {
      name: typeof json.name === 'string' ? json.name : undefined,
      scripts: stringRecord(json.scripts),
      dependencies: {
        ...stringRecord(json.devDependencies),
        ...stringRecord(json.dependencies),
      },
      bin: typeof json.bin === 'string' ? json.bin : binRecord(json.bin),
    };
  } catch {
    return undefined;
  }
};

const binRecord = (value: unknown): Record<string, string> | undefined =>
  value === undefined ? undefined : stringRecord(value);

const runScript = (cwd: string, script: string): string => {
  if (fs.existsSync(path.join(cwd, 'package-lock.json'))) {
    return `npm run ${script}`;
  }

  if (fs.existsSync(path.join(cwd, 'yarn.lock'))) {
    return `yarn ${script}`;
  }

  return `pnpm ${script}`;
};

const detectStart = (
  cwd: string,
  pkg: PackageJson | undefined
): { found: Found; script: string } | undefined => {
  const script = ['dev', 'start'].find(
    (name) => pkg?.scripts[name] !== undefined
  );

  return script === undefined
    ? undefined
    : {
        found: {
          key: 'app.start',
          value: runScript(cwd, script),
          source: `package.json "${script}"`,
        },
        script,
      };
};

const PORT_FLAG = /(?:--port[= ]|-p[= ]?)(\d{2,5})\b/;

const detectUrl = (
  pkg: PackageJson | undefined,
  script: string | undefined
): Found | Unknown => {
  const command = script === undefined ? undefined : pkg?.scripts[script];
  const port = command === undefined ? undefined : PORT_FLAG.exec(command)?.[1];

  if (port !== undefined) {
    return {
      key: 'app.url',
      value: `http://localhost:${port}`,
      source: `package.json "${script}"`,
    };
  }

  const framework = FRAMEWORK_PORTS.find(
    ({ dependency }) => pkg?.dependencies[dependency] !== undefined
  );

  return framework === undefined
    ? {
        key: 'app.url',
        note: 'no port or known framework found; set it by hand',
      }
    : {
        key: 'app.url',
        value: `http://localhost:${framework.port}`,
        source: `${framework.name} default`,
      };
};

const asProjectPath = (file: string): string =>
  file.startsWith('./') || file.startsWith('../') || path.isAbsolute(file)
    ? file
    : `./${path.normalize(file)}`;

const detectCli = (
  cwd: string,
  pkg: PackageJson | undefined
): Found | Unknown => {
  if (fs.existsSync(path.join(cwd, 'bin', 'lambda'))) {
    return { key: 'cli', value: './bin/lambda' };
  }

  if (typeof pkg?.bin === 'string') {
    return {
      key: 'cli',
      value: asProjectPath(pkg.bin),
      source: 'package.json "bin"',
    };
  }

  const entries = Object.entries(pkg?.bin ?? {});
  const [only] = entries;

  if (entries.length === 1 && only !== undefined) {
    return {
      key: 'cli',
      value: asProjectPath(only[1]),
      source: `package.json bin "${only[0]}"`,
    };
  }

  return {
    key: 'cli',
    note:
      entries.length > 1
        ? `package.json has ${entries.length} bin entries; set it by hand`
        : 'no bin/lambda or package.json bin found; set it by hand',
  };
};

const isFound = (value: Found | Unknown): value is Found => 'value' in value;

const gitConfig = (
  cwd: string,
  key: string,
  env: NodeJS.ProcessEnv
): string | undefined => {
  try {
    const value = execFileSync('git', ['config', key], {
      cwd,
      env,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();

    return value === '' ? undefined : value;
  } catch {
    return undefined;
  }
};

const tildePath = (file: string): string => {
  const home = os.homedir();

  return file.startsWith(`${home}${path.sep}`)
    ? `~${file.slice(home.length)}`
    : file;
};

const column = (key: string, value: string, source?: string): string =>
  source === undefined
    ? `  ${key.padEnd(13)} ${value}`
    : `  ${key.padEnd(13)} ${value.padEnd(25)} (${source})`;

/**
 * Add the lines `.lambda/.gitignore` lacks, never duplicating one. The
 * existing text is kept as it is (blank lines, CRLF); missing lines go on the
 * end.
 */
export const writeLambdaGitignore = (cwd: string): void => {
  const file = path.join(cwd, LAMBDA_GITIGNORE);
  const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const present = existing.split('\n').map((line) => line.trim());
  const missing = LAMBDA_GITIGNORE_LINES.filter(
    (line) => !present.includes(line)
  );

  if (missing.length === 0) {
    return;
  }

  const separator = existing === '' || existing.endsWith('\n') ? '' : '\n';

  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${existing}${separator}${missing.join('\n')}\n`);
};

export const runInit = (options: InitOptions): InitResult => {
  const { cwd } = options;
  const env = options.env ?? process.env;
  const configFile = path.join(cwd, PROJECT_CONFIG_FILE);

  if (
    fs.existsSync(configFile) &&
    options.force !== true &&
    options.dryRun !== true
  ) {
    return {
      code: 1,
      output: [],
      error: 'lambda.json already exists. Use --force to replace it.',
    };
  }

  const pkg = readPackageJson(cwd);
  const start = detectStart(cwd, pkg);
  const url = detectUrl(pkg, start?.script);
  const cli = detectCli(cwd, pkg);
  const instructions = INSTRUCTION_FILES.filter((name) =>
    fs.existsSync(path.join(cwd, name))
  );
  const hasTasks = fs.existsSync(path.join(cwd, TASKS_FILE));

  const app = {
    ...(start === undefined ? {} : { start: start.found.value }),
    ...(isFound(url) ? { url: url.value } : {}),
  };
  const config = {
    ...(Object.keys(app).length === 0 ? {} : { app }),
    ...(isFound(cli) ? { cli: cli.value } : {}),
    tickets: { source: 'markdown' },
    ...(instructions.length === 0 ? {} : { instructions }),
  };
  const json = `${JSON.stringify(config, null, 2)}\n`;

  const found: Found[] = [
    ...(start === undefined ? [] : [start.found]),
    ...(isFound(url) ? [url] : []),
    ...(isFound(cli) ? [cli] : []),
    {
      key: 'tickets',
      value: hasTasks ? `markdown (${TASKS_FILE})` : 'markdown',
    },
    ...(instructions.length === 0
      ? []
      : [{ key: 'instructions', value: instructions.join(', ') }]),
  ];

  const machineFile = machineConfigPath(env);
  const machineExists = fs.existsSync(machineFile);
  const name = options.name ?? gitConfig(cwd, 'user.name', env);
  const email = options.email ?? gitConfig(cwd, 'user.email', env);

  const unknown: Unknown[] = [
    ...(start === undefined
      ? [
          {
            key: 'app.start',
            note: 'no "dev" or "start" script found; set it by hand',
          },
        ]
      : []),
    ...(isFound(url) ? [] : [url]),
    ...(isFound(cli) ? [] : [cli]),
    ...(findPlaywrightDir(cwd, cwd) === undefined
      ? [
          {
            key: 'commands.e2e',
            note: 'no Playwright config found; set it by hand',
          },
        ]
      : []),
    ...(machineExists || name !== undefined
      ? []
      : [{ key: 'owner.name', note: 'run lambda init --name "<your name>"' }]),
  ];

  const summary = [
    pkg?.name ?? path.basename(cwd),
    '',
    'Found',
    ...found.map((item) => column(item.key, item.value, item.source)),
    ...(unknown.length === 0
      ? []
      : [
          '',
          "Couldn't tell",
          ...unknown.map((item) => column(item.key, item.note)),
        ]),
    '',
  ];

  if (options.dryRun === true) {
    return {
      code: 0,
      output: [
        ...summary,
        `Would write ${PROJECT_CONFIG_FILE}:`,
        json.trimEnd(),
      ],
    };
  }

  fs.writeFileSync(configFile, json);
  writeLambdaGitignore(cwd);

  const machineLine =
    machineExists || name === undefined
      ? []
      : [
          `Created ${tildePath(
            writeMachineConfig(
              { owner: { name, ...(email === undefined ? {} : { email }) } },
              env
            )
          )} for ${name} (${
            options.name === undefined ? 'from git' : 'from --name'
          })`,
        ];

  return {
    code: 0,
    output: [
      ...summary,
      `Wrote ${PROJECT_CONFIG_FILE}`,
      `Wrote .lambda/.gitignore (${LAMBDA_GITIGNORE_LINES.join(', ')})`,
      ...machineLine,
    ],
  };
};

export const registerInitCommand = (program: Command): void => {
  program
    .command('init')
    .description('Write lambda.json for this codebase')
    .option('--force', 'Replace an existing lambda.json')
    .option('--dry-run', 'Print the file it would write and stop')
    .option('--name <name>', 'Your name, for a new ~/.lambda/config.json')
    .option('--email <email>', 'Your email, for a new ~/.lambda/config.json')
    .action(
      (opts: {
        force?: boolean;
        dryRun?: boolean;
        name?: string;
        email?: string;
      }) => {
        const result = runInit({ cwd: process.cwd(), ...opts });
        result.output.forEach((line) => console.log(line));

        // The terminal path through setup: a project with lambda.json is set
        // up, its tickets in markdown until `lambda connect linear|jira`, so
        // `lambda start` and the app don't send this person to /setup.
        if (result.code === 0 && opts.dryRun !== true) {
          markProject(fs.realpathSync(process.cwd()), {
            project: true,
            tickets: true,
          });
        }

        if (result.error !== undefined) {
          console.error(result.error);
        }

        process.exitCode = result.code;
      }
    );
};
