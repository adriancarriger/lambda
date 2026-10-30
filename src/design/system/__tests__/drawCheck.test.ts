import * as path from 'path';

import * as render from '../../render';
import { buildSystem } from '../build';
import {
  DIR,
  PROJECT_NAME,
  catalogText,
  indexText,
  listTree,
  makeRepo,
  parksApp,
  quiet,
  sourcesText,
  tmp,
  treeHash,
  useReactRuntime,
} from './buildFixture';

// Real Chromium, one launch per component.
jest.setTimeout(120_000);

const COMPONENTS: Record<string, string> = {
  'src/components/Broken.tsx': [
    'export const Broken = ({ name }: { name: string }) => {',
    '  throw new Error(`Jerry broke the bench at ${name}`);',
    '};',
    '',
  ].join('\n'),
  'src/components/Blank.tsx': [
    'export const Blank = (_props: { name: string }) => null;',
    '',
  ].join('\n'),
  'src/components/Fetches.tsx': [
    "import { useEffect } from 'react';",
    '',
    'export const Fetches = ({ name }: { name: string }) => {',
    '  useEffect(() => {',
    "    fetch('https://api.pawnee.gov').catch(() => undefined);",
    '  }, []);',
    '',
    '  return <div>Opening hours for {name}</div>;',
    '};',
    '',
  ].join('\n'),
  // A dialog draws into document.body, away from the draw target.
  'src/components/Portalled.tsx': [
    "import { createPortal } from 'react-dom';",
    '',
    'export const Portalled = ({ name }: { name: string }) =>',
    '  createPortal(',
    "    <div style={{ position: 'fixed', bottom: 40, right: 40, padding: 16, background: '#2f6b3a' }}>",
    '      {name}',
    '    </div>,',
    '    document.body',
    '  );',
    '',
  ].join('\n'),
};

const NAMES = ['ParkCard', 'Broken', 'Blank', 'Fetches', 'Portalled'];

describe('the draw check', () => {
  const runtime = { restore: () => {} };

  beforeAll(() => {
    runtime.restore = useReactRuntime().restore;
  });

  afterAll(() => {
    runtime.restore();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('names what throws, draws nothing or reaches out, each drawn through its own artboard', async () => {
    const repo = makeRepo({
      ...parksApp(),
      // A padded Root has a box of its own even round a component that draws
      // nothing: only the pixels tell.
      'src/components/Root.css':
        '.pawnee-root { font-family: system-ui; padding: 24px; }\n',
      ...COMPONENTS,
      [`${DIR}/index.tsx`]: indexText(
        Object.fromEntries(
          NAMES.map((name) => [name, `../../src/components/${name}`])
        )
      ),
      [`${DIR}/catalog.ts`]: catalogText(NAMES.map((name) => ({ name }))),
      [`${DIR}/sources.json`]: sourcesText({
        components: Object.fromEntries(
          NAMES.map((name) => [name, `src/components/${name}.tsx`])
        ),
      }),
    });
    repo.commit('Pawnee parks map design system');
    const source = treeHash(path.join(repo.root, DIR));
    const real = render.withArtboard;
    const drawn: string[] = [];
    jest.spyOn(render, 'withArtboard').mockImplementation((options, use) => {
      drawn.splice(drawn.length, 0, options.artboard);

      return real(options, use);
    });

    const result = await buildSystem({
      project: repo.project(),
      projectName: PROJECT_NAME,
      checkout: repo.root,
      out: path.join(tmp('lambda-ds-out-'), 'system'),
      check: true,
      log: quiet,
    });

    expect(result.problems).toEqual([
      'Broken failed to draw: Jerry broke the bench at Pawnee Commons',
      'Blank failed to draw: nothing drawn',
      'Fetches reached api.pawnee.gov.',
    ]);
    expect(drawn).toEqual(NAMES.map((name) => `_draw-${name}.dc.html`));

    // The previews are never opened: the check canvas holds none of them.
    const canvas = listTree(
      path.join(repo.root, '.lambda', 'design', '_system-check', 'canvas')
    );
    expect(canvas.filter((file) => file.endsWith('preview.html'))).toEqual([]);
    expect(canvas).toEqual(
      expect.arrayContaining(
        NAMES.map((name) => path.join('project', `_draw-${name}.dc.html`))
      )
    );
    expect(treeHash(path.join(repo.root, DIR))).toBe(source);
    expect(repo.git(['status', '--porcelain'])).toBe('');
  });
});
