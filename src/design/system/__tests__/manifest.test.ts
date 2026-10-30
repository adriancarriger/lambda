import * as fs from 'fs';
import * as path from 'path';

import { ProjectConfigSchema } from '../../../config/projectConfig';
import {
  ManifestSchema,
  manifestText,
  mergeManifest,
  parseManifest,
  readManifestAt,
  readManifestFile,
} from '../manifest';
import { writeSetupManifest } from '../manifestWrite';
import { HAND_MADE_MANIFEST } from './fixtures/handMade';
import { commitAll, initRepo, put, run } from './gitFixture';

const SHA40 = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';

const text = (value: object): string => JSON.stringify(value);

const parseError = (value: object): string => {
  try {
    parseManifest(text(value), 'design-system.json');
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }

  throw new Error('Expected the manifest to be refused.');
};

describe('the manifest schema', () => {
  it('reads a hand-made manifest: builtFrom from publishedSha, and made by hand', () => {
    const read = parseManifest(text(HAND_MADE_MANIFEST), 'design-system.json');

    expect(read.builtFrom).toBe('b81f04c2e');
    expect(read.madeByHand).toBe(true);
    expect(read.manifest.version).toBeUndefined();
    expect(read.manifest.namespace).toBe('Harvest');
    // Unknown fields are kept, in order.
    expect(Object.keys(read.raw)).toEqual([
      'url',
      'namespace',
      'publishedSha',
      'createdAt',
      'files',
    ]);
    expect(read.manifest).toMatchObject({
      url: HAND_MADE_MANIFEST.url,
      createdAt: HAND_MADE_MANIFEST.createdAt,
      files: HAND_MADE_MANIFEST.files,
    });
  });

  it.each([
    ['7', 'a1b2c3d'],
    ['40', SHA40],
  ])('reads a publishedSha of %s hex characters', (_, sha) => {
    expect(
      parseManifest(
        text({ namespace: 'Pawnee', publishedSha: sha }),
        'design-system.json'
      ).builtFrom
    ).toBe(sha);
  });

  it.each([
    ['6 characters', 'a1b2c3'],
    ['a non-hex character', 'a1b2c3g'],
  ])('refuses a publishedSha of %s, naming publishedSha', (_, sha) => {
    expect(parseError({ namespace: 'Pawnee', publishedSha: sha })).toContain(
      'publishedSha'
    );
  });

  it.each([['a1b2c3d'], [SHA40]])('accepts builtFrom %s', (sha) => {
    const read = parseManifest(
      text({ namespace: 'Pawnee', version: 2, builtFrom: sha }),
      'design-system.json'
    );

    expect(read.builtFrom).toBe(sha);
    expect(read.madeByHand).toBe(false);
  });

  it('prefers builtFrom over publishedSha', () => {
    expect(
      parseManifest(
        text({
          namespace: 'Pawnee',
          builtFrom: 'a1b2c3d',
          publishedSha: SHA40,
        }),
        'm'
      ).builtFrom
    ).toBe('a1b2c3d');
  });

  it('refuses a namespace that is not PascalCase, naming namespace', () => {
    expect(parseError({ namespace: 'pawnee' })).toContain('namespace');
  });

  it.each([
    ['a version of 0', { namespace: 'Pawnee', version: 0 }, 'version'],
    ['an unknown source', { namespace: 'Pawnee', source: 'sketch' }, 'source'],
    [
      'a check issue of an unknown severity',
      {
        namespace: 'Pawnee',
        check: {
          result: 'close',
          rounds: 4,
          photos: 3,
          issues: [{ severity: 'High', where: 'Buttons', what: 'corners' }],
        },
      },
      'check.issues.0.severity',
    ],
  ])('refuses %s, naming the field', (_, value, field) => {
    expect(parseError(value)).toContain(field);
  });

  it('refuses a manifest that is not an object', () => {
    expect(() => parseManifest('[]', 'design-system.json')).toThrow(
      'design-system.json must be a JSON object.'
    );
  });

  it('refuses text that is not JSON, naming the file', () => {
    expect(() =>
      parseManifest('{ "namespace": ', 'design-system.json')
    ).toThrow(/^design-system\.json is not valid JSON: /);
  });

  it('accepts a full Lambda-made manifest', () => {
    expect(
      ManifestSchema.safeParse({
        namespace: 'PawneeParksMap',
        version: 1,
        builtFrom: 'a1b2c3d',
        syncedBy: 'PAWNEE-12',
        source: 'code+photos',
        check: {
          result: 'close',
          rounds: 4,
          photos: 3,
          issues: [
            { severity: 'medium-low', where: 'Buttons', what: '4px rounder' },
          ],
        },
        components: ['ParkCard'],
        patterns: ['MapView'],
        screens: ['Parks list'],
        leftOut: [{ name: 'MapView', why: 'loads mapbox-gl' }],
      }).success
    ).toBe(true);
  });
});

describe('mergeManifest', () => {
  it('keeps known keys in place, adds new ones at the end, and skips undefined', () => {
    const merged = mergeManifest(
      { url: 'u', namespace: 'Pawnee', version: 1, files: ['a'] },
      { version: 2, syncedBy: 'PAWNEE-12', builtFrom: undefined }
    );

    expect(Object.entries(merged)).toEqual([
      ['url', 'u'],
      ['namespace', 'Pawnee'],
      ['version', 2],
      ['files', ['a']],
      ['syncedBy', 'PAWNEE-12'],
    ]);
  });

  it('writes two-space JSON with a trailing newline', () => {
    expect(manifestText({ namespace: 'Pawnee' })).toBe(
      '{\n  "namespace": "Pawnee"\n}\n'
    );
  });
});

describe('reading the manifest at a ref', () => {
  const MANIFEST = '.lambda/design-system/design-system.json';

  it('reads it as committed, never from the working tree, and null where the ref has none', () => {
    const root = initRepo();
    put(root, 'README.md', 'Pawnee parks map\n');
    const before = commitAll(root, 'Start');
    put(root, MANIFEST, manifestText({ namespace: 'Pawnee', version: 1 }));
    const after = commitAll(root, 'PAWNEE-12: Make the design system');
    put(root, MANIFEST, manifestText({ namespace: 'Pawnee', version: 9 }));

    expect(readManifestAt(root, before, MANIFEST)).toBeNull();
    expect(readManifestAt(root, after, MANIFEST)?.manifest.version).toBe(1);
    expect(readManifestAt(root, 'main', MANIFEST)?.manifest.version).toBe(1);
    expect(readManifestFile(path.join(root, MANIFEST))?.manifest.version).toBe(
      9
    );
  });

  it('throws for a ref that is not a commit, never reading it as no design system', () => {
    const root = initRepo();
    put(root, 'README.md', 'Pawnee parks map\n');
    commitAll(root, 'Before the design system');

    expect(readManifestAt(root, 'main', MANIFEST)).toBeNull();
    expect(() => readManifestAt(root, 'no-such-branch', MANIFEST)).toThrow(
      'no-such-branch is not a commit'
    );
  });

  it('throws naming the ref and file when the committed manifest is bad', () => {
    const root = initRepo();
    put(root, MANIFEST, manifestText({ namespace: 'pawnee' }));
    commitAll(root, 'Bad manifest');

    expect(() => readManifestAt(root, 'main', MANIFEST)).toThrow(
      `main:${MANIFEST}: namespace`
    );
  });

  it('reads it relative to a project in a subfolder of its repo', () => {
    const root = initRepo();
    put(
      root,
      `apps/parks/${MANIFEST}`,
      manifestText({ namespace: 'Pawnee', version: 3 })
    );
    commitAll(root, 'Pawnee parks map');

    expect(
      readManifestAt(path.join(root, 'apps/parks'), 'main', MANIFEST)?.manifest
        .version
    ).toBe(3);
  });

  it('reads no manifest file as null', () => {
    expect(readManifestFile(path.join(initRepo(), 'none.json'))).toBeNull();
  });
});

describe('manifest write over a hand-made manifest', () => {
  it('keeps url, publishedSha, createdAt and files in their places, and adds version 1 and syncedBy', async () => {
    const root = initRepo();
    const manifestPath = 'docs/parks/design-system.json';
    put(root, manifestPath, manifestText(HAND_MADE_MANIFEST));
    put(root, '.lambda/design-system/index.tsx', 'export {};\n');
    const base = commitAll(root, 'Hand-made design system');
    const project = {
      root,
      file: path.join(root, 'lambda.json'),
      config: ProjectConfigSchema.parse({
        design: { system: { manifest: manifestPath } },
      }),
    };

    await writeSetupManifest({
      project,
      projectName: 'Pawnee parks map',
      checkout: root,
      base: 'main',
      ticketId: 'PAWNEE-12',
      notChecked:
        'this codebase has no photo hook (commands.shot in lambda.json)',
    });
    const written: unknown = JSON.parse(
      fs.readFileSync(path.join(root, manifestPath), 'utf8')
    );

    expect(written).toEqual(
      expect.objectContaining({
        ...HAND_MADE_MANIFEST,
        version: 1,
        syncedBy: 'PAWNEE-12',
        builtFrom: base,
      })
    );
    expect(Object.keys(Object(written)).slice(0, 5)).toEqual([
      'url',
      'namespace',
      'publishedSha',
      'createdAt',
      'files',
    ]);
    expect(run(root, ['status', '--porcelain'])).toBe(`M ${manifestPath}`);
  });
});
