import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { MachineDesignSchema } from '../machineConfig';
import { ProjectConfigSchema, loadProjectConfig } from '../projectConfig';

const tmp = (): string =>
  fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lambda-design-')));

/** The one-line refusal loading this lambda.json gives. */
const refusalOf = (config: unknown): string => {
  const root = tmp();
  fs.writeFileSync(path.join(root, 'lambda.json'), JSON.stringify(config));

  try {
    loadProjectConfig(root);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }

  return '';
};

describe("lambda.json's design block and photo hook", () => {
  it('fills every design default when the block is absent', () => {
    const parsed = ProjectConfigSchema.parse({});

    expect(parsed.design).toEqual({
      scenarios: '.lambda/scenarios',
      scenarioExt: 'json',
      pendingDir: '.lambda/scenarios-pending',
      system: {
        dir: '.lambda/design-system',
        manifest: '.lambda/design-system/design-system.json',
      },
    });
  });

  it('keeps a project’s own folders and extension', () => {
    const parsed = ProjectConfigSchema.parse({
      design: {
        scenarios: 'app/scenarios',
        scenarioExt: 'ts',
        pendingDir: 'var/pending',
      },
    });

    expect(parsed.design.scenarios).toBe('app/scenarios');
    expect(parsed.design.scenarioExt).toBe('ts');
    expect(parsed.design.pendingDir).toBe('var/pending');
  });

  it('keeps commands.shot', () => {
    expect(
      ProjectConfigSchema.parse({
        commands: { shot: 'node shoot.js {scenario} {out}' },
      }).commands?.shot
    ).toBe('node shoot.js {scenario} {out}');
  });

  it.each([
    ['design.scenarios', { design: { scenarios: '../x' } }],
    ['design.scenarios', { design: { scenarios: '/abs' } }],
    ['design.pendingDir', { design: { pendingDir: 'a/../../b' } }],
    ['design.system.dir', { design: { system: { dir: '../ds' } } }],
    ['design.system.dir', { design: { system: { dir: '../x' } } }],
    ['design.system.dir', { design: { system: { dir: '/abs' } } }],
    [
      'design.system.manifest',
      { design: { system: { manifest: '../m.json' } } },
    ],
    [
      'design.systemBuild.exclude.0',
      { design: { systemBuild: { exclude: ['../x'] } } },
    ],
    [
      'design.systemBuild.theme.0',
      { design: { systemBuild: { theme: ['/abs/theme.ts'] } } },
    ],
    [
      'design.systemBuild.components.0',
      { design: { systemBuild: { components: ['src/../../x.tsx'] } } },
    ],
  ])('refuses %s outside the project, naming it', (field, config) => {
    expect(refusalOf(config)).toContain(
      `${field} must be a path inside the codebase`
    );
  });

  it('refuses a design.system.build with no {out}, naming it', () => {
    expect(refusalOf({ design: { system: { build: 'make ds' } } })).toContain(
      'design.system.build must contain {out}'
    );
  });

  // git names paths plainly, so a dir spelled `./ds/` would never match one.
  it('stores the design system paths plainly however they are spelled', () => {
    expect(
      ProjectConfigSchema.parse({
        design: { system: { dir: './design//ds/', manifest: './m/ds.json' } },
      }).design.system
    ).toEqual({ dir: 'design/ds', manifest: 'm/ds.json' });
  });

  it.each([['.'], ['./']])(
    'refuses the project itself as design.system.dir: %s',
    (dir) => {
      expect(refusalOf({ design: { system: { dir } } })).toContain(
        'design.system.dir must be a path inside the codebase'
      );
    }
  );

  it('puts the manifest in a chosen dir by default', () => {
    expect(
      ProjectConfigSchema.parse({ design: { system: { dir: 'design/ds' } } })
        .design.system
    ).toEqual({ dir: 'design/ds', manifest: 'design/ds/design-system.json' });
  });

  // A monorepo app's design system folder, with its manifest kept elsewhere.
  it('accepts a nested dir, its own manifest and a build with {out}', () => {
    const config = {
      design: {
        system: {
          dir: 'web/src/designSystem',
          manifest: 'docs/look/design-system.json',
          build: 'make design-system OUT={out}',
        },
        systemBuild: {
          theme: ['web/src/theme.ts'],
          components: ['web/src/components/**/*.tsx'],
          exclude: ['web/src/components/Map*.tsx'],
        },
      },
    };

    expect(refusalOf(config)).toBe('');
    expect(ProjectConfigSchema.parse(config).design).toMatchObject(
      config.design
    );
  });

  // Its `.gitignore` of `*` would hide the whole project, or the scenarios.
  it.each([
    [{ pendingDir: '.' }],
    [{ pendingDir: './' }],
    [{ pendingDir: '.lambda/scenarios' }],
    [{ pendingDir: '.lambda' }],
    [{ pendingDir: '.lambda/scenarios/pending' }],
  ])(
    'refuses a pendingDir that is the project or overlaps the scenarios: %j',
    (design) => {
      expect(refusalOf({ design })).toContain('design.pendingDir');
    }
  );

  it('refuses a scenario extension that is not one plain word', () => {
    expect(refusalOf({ design: { scenarioExt: '.json' } })).toContain(
      'design.scenarioExt'
    );
  });
});

describe("~/.lambda/config.json's design", () => {
  const checkedAt = '2026-10-23T10:00:00.000Z';

  it.each([
    [{ available: true, checkedAt }],
    [{ available: true, typeUrl: 'https://pawnee.gov/design', checkedAt }],
    [
      {
        available: false,
        systemTypeUrl: 'https://claude.ai/artifact/x/more',
        checkedAt,
      },
    ],
  ])(
    'refuses %j: available needs a Design type, and type links are artifact links',
    (design) => {
      expect(MachineDesignSchema.safeParse(design).success).toBe(false);
    }
  );

  it('keeps an available design with its type', () => {
    expect(
      MachineDesignSchema.safeParse({
        available: true,
        typeUrl: 'https://claude.ai/artifact/TestDesignType1',
        checkedAt,
      }).success
    ).toBe(true);
  });
});
