import { buildingPodStore } from '../../building/__tests__/fakes';
import { runPeek } from '../peek';
import './podProject';

/** `--lines` that isn't a positive whole number never reaches tmux. */

const recorded: { captured: { target: string; lines: number }[] } = {
  captured: [],
};

jest.mock('../tmux', () => ({
  ...jest.requireActual('../tmux'),
  capturePane: (target: string, lines: number) => {
    recorded.captured = [...recorded.captured, { target, lines }];

    return 'the pane\n';
  },
}));

afterEach(() => {
  delete process.env.LAMBDA_PODS_ROOT;
  recorded.captured = [];
});

const peekWith = (lines: number) => {
  const { store } = buildingPodStore();
  process.env.LAMBDA_PODS_ROOT = store.root;
  const out: { printed: string[] } = { printed: [] };
  runPeek('dev', { pod: 'build-a1b2', lines }, (text) => {
    out.printed = [...out.printed, text];
  });

  return out.printed;
};

describe('lambda pod peek --lines', () => {
  it.each([Number('abc'), 0, -5, 2.5])('refuses %s', (lines) => {
    expect(() => peekWith(lines)).toThrow(
      '--lines must be a positive whole number.'
    );
    expect(recorded.captured).toEqual([]);
  });

  it('captures that many lines', () => {
    expect(peekWith(20)).toEqual(['the pane\n']);
    expect(recorded.captured).toEqual([
      { target: '=lambda-pod-build-a1b2:=dev', lines: 20 },
    ]);
  });
});
