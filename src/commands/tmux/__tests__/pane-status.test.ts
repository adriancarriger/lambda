import { execSync } from 'child_process';

import {
  KNOWN_SHELLS,
  getPaneCurrentCommand,
  getPaneStatusTag,
  isShellIdle,
} from '../pane-status';

jest.mock('child_process');

const mockExecSync = jest.mocked(execSync);

describe('KNOWN_SHELLS', () => {
  it('should contain standard shell names', () => {
    expect(KNOWN_SHELLS).toContain('zsh');
    expect(KNOWN_SHELLS).toContain('bash');
    expect(KNOWN_SHELLS).toContain('fish');
    expect(KNOWN_SHELLS).toContain('sh');
    expect(KNOWN_SHELLS).toContain('dash');
    expect(KNOWN_SHELLS).toContain('login');
  });
});

describe('getPaneCurrentCommand', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should return the current command from tmux', () => {
    mockExecSync.mockReturnValue('node\n');

    const result = getPaneCurrentCommand('lambda:scratchPad');

    expect(result).toBe('node');
    expect(mockExecSync).toHaveBeenCalledWith(
      'tmux display-message -t "lambda:scratchPad" -p \'#{pane_current_command}\'',
      { encoding: 'utf-8', timeout: 5000 }
    );
  });

  it('should return null when command is empty', () => {
    mockExecSync.mockReturnValue('\n');

    expect(getPaneCurrentCommand('lambda:scratchPad')).toBeNull();
  });

  it('should return null when tmux throws', () => {
    mockExecSync.mockImplementation(() => {
      throw new Error('pane not found');
    });

    expect(getPaneCurrentCommand('lambda:scratchPad')).toBeNull();
  });
});

describe('isShellIdle', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should return true when running zsh', () => {
    mockExecSync.mockReturnValue('zsh\n');

    expect(isShellIdle('lambda:scratchPad')).toBe(true);
  });

  it('should return true when running bash', () => {
    mockExecSync.mockReturnValue('bash\n');

    expect(isShellIdle('lambda:scratchPad')).toBe(true);
  });

  it('should return true for full path like /bin/zsh', () => {
    mockExecSync.mockReturnValue('/bin/zsh\n');

    expect(isShellIdle('lambda:scratchPad')).toBe(true);
  });

  it('should return false when running a command', () => {
    mockExecSync.mockReturnValue('node\n');

    expect(isShellIdle('lambda:scratchPad')).toBe(false);
  });

  it('should return false when running sleep', () => {
    mockExecSync.mockReturnValue('sleep\n');

    expect(isShellIdle('lambda:scratchPad')).toBe(false);
  });

  it('should return false when tmux throws', () => {
    mockExecSync.mockImplementation(() => {
      throw new Error('error');
    });

    expect(isShellIdle('lambda:scratchPad')).toBe(false);
  });
});

describe('getPaneStatusTag', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should return [idle] when shell is running', () => {
    mockExecSync.mockReturnValue('zsh\n');

    expect(getPaneStatusTag('lambda:scratchPad')).toBe('[idle]');
  });

  it('should return [idle] when command is null', () => {
    mockExecSync.mockImplementation(() => {
      throw new Error('error');
    });

    expect(getPaneStatusTag('lambda:scratchPad')).toBe('[idle]');
  });

  it('should return [running: node] when node is running', () => {
    mockExecSync.mockReturnValue('node\n');

    expect(getPaneStatusTag('lambda:scratchPad')).toBe('[running: node]');
  });

  it('should return [running: sleep] when sleep is running', () => {
    mockExecSync.mockReturnValue('sleep\n');

    expect(getPaneStatusTag('lambda:scratchPad')).toBe('[running: sleep]');
  });

  it('should return [running: python] for python process', () => {
    mockExecSync.mockReturnValue('python\n');

    expect(getPaneStatusTag('lambda:scratchPad')).toBe('[running: python]');
  });

  it('should return [idle] for login shell', () => {
    mockExecSync.mockReturnValue('login\n');

    expect(getPaneStatusTag('lambda:scratchPad')).toBe('[idle]');
  });

  it('should return [idle] for fish shell', () => {
    mockExecSync.mockReturnValue('fish\n');

    expect(getPaneStatusTag('lambda:scratchPad')).toBe('[idle]');
  });
});
