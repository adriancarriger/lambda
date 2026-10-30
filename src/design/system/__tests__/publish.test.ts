import * as fs from 'fs';
import * as path from 'path';

import {
  type ArtifactCall,
  MAX_FILES_PER_CALL,
  REMOVED_FILES_NOTE,
  publishPlan,
} from '../publish';
import { put, tmpDir } from './gitFixture';

const TYPE_URL = 'https://claude.ai/artifact/PawneeSystemType1';
const INDEX = 'project/design-system.json';
const README = 'project/README.md';

/**
 * A project with a lambda.json and a manifest, and a built design system in
 * its gitignored `.lambda/design/system/` holding `count` files in all.
 */
const builtProject = (
  count: number
): { root: string; built: string; before: () => Record<string, string> } => {
  const root = tmpDir('lambda-ds-publish-');
  put(root, 'lambda.json', '{ "name": "Pawnee parks map" }\n');
  put(
    root,
    '.lambda/design-system/design-system.json',
    '{\n  "namespace": "PawneeParksMap",\n  "version": 1\n}\n'
  );
  const built = path.join(root, '.lambda', 'design', 'system');
  put(built, INDEX, '{ "v": 3 }\n');
  put(built, README, '# Pawnee parks map\n');
  put(built, 'project/components/index.d.ts', 'export {};\n');
  put(built, 'project/tokens.json', '{}\n');
  Array.from({ length: count - 4 }).forEach((_, index) =>
    put(
      built,
      `project/components/Park${String(index).padStart(3, '0')}/README.md`,
      `# Park ${index}\n`
    )
  );
  const files = ['lambda.json', '.lambda/design-system/design-system.json'];

  return {
    root,
    built,
    before: () =>
      Object.fromEntries(
        files.map((rel) => [rel, fs.readFileSync(path.join(root, rel), 'utf8')])
      ),
  };
};

const fileCount = (call: ArtifactCall): number =>
  Object.keys(call.files).length;

describe('publishPlan', () => {
  it('creates from the Design System type without --url, index last', () => {
    const { built, before } = builtProject(6);
    const snapshot = before();

    const plan = publishPlan({
      builtDir: built,
      typeUrl: TYPE_URL,
      title: 'Pawnee parks map',
    });
    const [call] = plan.calls;

    expect(plan.calls).toHaveLength(1);
    expect(call).toMatchObject({
      type_url: TYPE_URL,
      title: 'Pawnee parks map',
      root: built,
      file_path: path.join(built, README),
    });
    expect(call?.url).toBeUndefined();
    expect(Object.keys(call?.files ?? {}).at(-1)).toBe(INDEX);
    expect(Object.keys(call?.files ?? {})).not.toContain(README);
    expect(Object.keys(call?.files ?? {})).toHaveLength(5);
    expect(plan.notes).toEqual([]);
    expect(before()).toEqual(snapshot);
  });

  it('a create of a big folder carries the first part and says to publish the rest', () => {
    const { built, before } = builtProject(300);
    const snapshot = before();

    const plan = publishPlan({
      builtDir: built,
      typeUrl: TYPE_URL,
      title: 'Pawnee parks map',
    });

    expect(plan.calls).toHaveLength(1);
    expect(plan.calls.map(fileCount)).toEqual([MAX_FILES_PER_CALL]);
    expect(plan.notes).toEqual([
      'This create carries the first 255 files. Then run: lambda design system publish --url <the new link> for the rest.',
    ]);
    expect(before()).toEqual(snapshot);
  });

  it('splits 300 files to an existing link into calls of 254 + the README, and 45, index last', () => {
    const { built, before } = builtProject(300);
    const snapshot = before();
    const url = 'https://claude.ai/artifact/x';

    const plan = publishPlan({
      builtDir: built,
      url,
      title: 'Pawnee parks map',
    });

    // The service counts each call's file_path (the README) as a file, so a
    // 255-file call is 254 files + the README, then 45.
    expect(MAX_FILES_PER_CALL).toBe(254);
    expect(plan.calls.map(fileCount)).toEqual([254, 45]);
    plan.calls.forEach((call) => {
      expect(call.url).toBe(url);
      expect(call.type_url).toBeUndefined();
      expect(call.file_path).toBe(path.join(built, README));
      expect(fileCount(call) + 1).toBeLessThanOrEqual(255);
    });
    expect(Object.keys(plan.calls[1]?.files ?? {}).at(-1)).toBe(INDEX);
    expect(Object.keys(plan.calls[0]?.files ?? {})).not.toContain(INDEX);
    // Every built file is sent once: 299 in files, plus the README.
    const sent = plan.calls.flatMap((call) => Object.keys(call.files));
    expect(new Set(sent).size).toBe(299);
    expect(sent).not.toContain(README);
    expect(plan.notes).toContain(REMOVED_FILES_NOTE);
    expect(REMOVED_FILES_NOTE).toBe(
      'Files removed since an earlier publish stay in the published copy.'
    );
    expect(before()).toEqual(snapshot);
  });

  it('sends a .ts file as text/plain', () => {
    const { built } = builtProject(6);

    const [call] = publishPlan({
      builtDir: built,
      url: 'https://claude.ai/code/artifact/pawnee-1',
      title: 'Pawnee parks map',
    }).calls;

    expect(call?.files['project/components/index.d.ts']).toEqual({
      from: 'project/components/index.d.ts',
      contentType: 'text/plain',
    });
    expect(call?.files['project/tokens.json']).toBe('project/tokens.json');
  });

  it.each([
    ['https://claude.ai/artifact/x/edit'],
    ['https://claude.ai/chat/x'],
    ['http://claude.ai/artifact/x'],
  ])('refuses --url %s, writing nothing', (url) => {
    const { built, before } = builtProject(6);
    const snapshot = before();

    expect(() =>
      publishPlan({ builtDir: built, url, title: 'Pawnee parks map' })
    ).toThrow(`Refusing --url ${url}`);
    expect(before()).toEqual(snapshot);
  });

  it('refuses a create with no Design System type recorded', () => {
    const { built } = builtProject(6);

    expect(() =>
      publishPlan({ builtDir: built, title: 'Pawnee parks map' })
    ).toThrow('No Design System type is recorded on this computer');
  });

  it('refuses a folder that is not a built design system', () => {
    const empty = tmpDir('lambda-ds-unbuilt-');

    expect(() =>
      publishPlan({
        builtDir: empty,
        url: 'https://claude.ai/artifact/x',
        title: 'Pawnee parks map',
      })
    ).toThrow('is not a built design system');
  });
});
