import { Command } from 'commander';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  type Project,
  ProjectConfigSchema,
} from '../../../config/projectConfig';
import { registerAwaitCommand } from '../../await';
import { RECEIPT_DIR } from '../../wait';
import {
  TMUX_NOT_FOUND,
  isAgentPane,
  registerTmuxCommand,
  resolveTmuxSettings,
  tmuxTarget,
} from '../index';

const project = (config: object): Project => ({
  root: '/pawnee',
  file: '/pawnee/lambda.json',
  config: ProjectConfigSchema.parse(config),
});

describe('tmux session and agent windows', () => {
  it('uses the lambda session by default', () => {
    expect(tmuxTarget('dev', resolveTmuxSettings(null, {}))).toBe('lambda:dev');
    expect(tmuxTarget('dev', resolveTmuxSettings(project({}), {}))).toBe(
      'lambda:dev'
    );
  });

  it('uses tmux.session from lambda.json', () => {
    expect(
      tmuxTarget(
        'dev',
        resolveTmuxSettings(project({ tmux: { session: 'pawnee' } }), {})
      )
    ).toBe('pawnee:dev');
  });

  it("refuses a pod whose record can't be read, rather than guessing its session", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tmux-pods-'));
    fs.mkdirSync(path.join(root, 'pawnee-a1b2'), { recursive: true });
    fs.writeFileSync(path.join(root, 'pawnee-a1b2', 'pod.json'), '{"id": 7');

    expect(() =>
      resolveTmuxSettings(project({}), {
        POD_ID: 'pawnee-a1b2',
        LAMBDA_PODS_ROOT: root,
      })
    ).toThrow(/pawnee-a1b2/);
    // A pod with no record at all is still a planning pod's layout.
    expect(
      tmuxTarget(
        'dev',
        resolveTmuxSettings(project({}), {
          POD_ID: 'pawnee-c3d4',
          LAMBDA_PODS_ROOT: root,
        })
      )
    ).toBe('lambda-pod-pawnee-c3d4:dev');
  });

  it("uses a planning pod's own session and roles when POD_ID is set", () => {
    const settings = resolveTmuxSettings(
      project({ tmux: { session: 'pawnee', agentWindows: ['writer'] } }),
      { POD_ID: 'pawnee-a1b2' }
    );

    expect(tmuxTarget('dev', settings)).toBe('lambda-pod-pawnee-a1b2:dev');
    expect(isAgentPane('manager', settings)).toBe(true);
    expect(isAgentPane('dev', settings)).toBe(true);
    expect(isAgentPane('qa', settings)).toBe(false);
  });

  it('uses tmux.agentWindows from lambda.json', () => {
    const settings = resolveTmuxSettings(
      project({ tmux: { agentWindows: ['writer'] } }),
      {}
    );

    expect(isAgentPane('writer', settings)).toBe(true);
    expect(isAgentPane('dev', settings)).toBe(false);
  });

  it('keeps wait receipts in /tmp/lambda-wait-receipts', () => {
    expect(RECEIPT_DIR).toBe('/tmp/lambda-wait-receipts');
  });
});

describe('without tmux on PATH', () => {
  const savedPath = process.env.PATH;
  const errors: string[] = [];

  beforeEach(() => {
    process.env.PATH = fs.mkdtempSync(path.join(os.tmpdir(), 'lambda-path-'));
    errors.length = 0;
    jest.spyOn(console, 'error').mockImplementation((message: string) => {
      errors.splice(errors.length, 0, message);
    });
    jest.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Error(`exit ${code}`);
    });
  });

  afterEach(() => {
    process.env.PATH = savedPath;
    jest.restoreAllMocks();
  });

  it.each([[['tmux', 'dev', 'hi']], [['await', 'dev']]])(
    'lambda %j exits 1 with tmux not found',
    async (args) => {
      const program = new Command();
      registerTmuxCommand(program);
      registerAwaitCommand(program);

      await expect(
        program.parseAsync(['node', 'lambda', ...args])
      ).rejects.toThrow('exit 1');
      expect(errors).toEqual([TMUX_NOT_FOUND]);
    }
  );
});
