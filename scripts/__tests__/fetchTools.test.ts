import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const PACKAGE = path.resolve(__dirname, '..', '..');
const SCRIPT = path.join(PACKAGE, 'desktop', 'tools', 'fetch-tools.sh');

/** The pinned SHA-256 of each tarball, read from the script itself. */
const pinned = (name: string): string => {
  const match = new RegExp(`^${name}_SHA256="([0-9a-f]+)"$`, 'm').exec(
    fs.readFileSync(SCRIPT, 'utf8')
  );

  if (match?.[1] === undefined) {
    throw new Error(`fetch-tools.sh pins no ${name}_SHA256`);
  }

  return match[1];
};

const stub = (dir: string, name: string, body: string): void => {
  fs.writeFileSync(path.join(dir, name), `#!/bin/sh\n${body}\n`, {
    mode: 0o755,
  });
};

/**
 * A copy of fetch-tools.sh in a temp folder (it builds next to itself),
 * with curl, shasum, tar, make and otool stubbed: no download, no compile.
 * `foreign` makes otool report tmux linking a Homebrew library.
 */
const toolsDir = (
  options: { tamperedTmux?: boolean } = {}
): { dir: string; run: (foreign: boolean) => string } => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lambda-fetch-tools-'));
  const tools = path.join(dir, 'tools');
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(tools);
  fs.mkdirSync(bin);
  fs.copyFileSync(SCRIPT, path.join(tools, 'fetch-tools.sh'));

  // The "tarball" holds its pinned SHA-256, which the shasum stub prints.
  stub(
    bin,
    'curl',
    [
      'for a; do out="$url"; url="$a"; done',
      'case "$url" in',
      `  *libevent*) sha=${pinned('LIBEVENT')} ;;`,
      `  *tmux*) sha=${
        options.tamperedTmux === true ? '0'.repeat(64) : pinned('TMUX')
      } ;;`,
      `  *git*) sha=${pinned('GIT')} ;;`,
      'esac',
      'printf "%s" "$sha" > "$out"',
    ].join('\n')
  );
  stub(bin, 'shasum', 'echo "$(cat "$3")  $3"');
  // `tar -xzf <file> -C <dir>`: a source folder with a configure that passes.
  stub(
    bin,
    'tar',
    [
      'src="$4/$(basename "$2" .tar.gz)"',
      'mkdir -p "$src"',
      'printf "#!/bin/sh\\n" > "$src/configure"',
      'chmod +x "$src/configure"',
      'printf "#!/bin/sh\\n" > "$src/tmux"',
      'chmod +x "$src/tmux"',
    ].join('\n')
  );
  // git's `make ... DESTDIR=<dir> install` lays out the install.
  stub(
    bin,
    'make',
    [
      'for a; do case "$a" in DESTDIR=*) d="${a#DESTDIR=}" ;; esac; done',
      '[ -z "$d" ] && exit 0',
      'mkdir -p "$d/bin" "$d/libexec/git-core" "$d/share/git-core"',
      'printf "#!/bin/sh\\n" > "$d/bin/git"',
      'chmod +x "$d/bin/git"',
    ].join('\n')
  );

  return {
    dir,
    run: (foreign) => {
      stub(
        bin,
        'otool',
        [
          'echo "$2:"',
          'echo "	/usr/lib/libSystem.B.dylib (compatibility version 1.0.0)"',
          foreign
            ? 'case "$2" in *tmux) echo "	/opt/homebrew/lib/libevent.dylib (compatibility version 1.0.0)" ;; esac'
            : '',
        ].join('\n')
      );
      const result = spawnSync('bash', [path.join(tools, 'fetch-tools.sh')], {
        env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}` },
        encoding: 'utf8',
      });

      return `${result.stdout}${result.stderr}exit ${String(result.status)}`;
    },
  };
};

describe('fetch-tools.sh', () => {
  const made: string[] = [];

  afterEach(() => {
    made
      .splice(0)
      .forEach((dir) => fs.rmSync(dir, { recursive: true, force: true }));
  });

  it('builds tmux and git into out/ when every binary links only system libraries', () => {
    const tools = toolsDir();
    made.splice(made.length, 0, tools.dir);

    expect(tools.run(false)).toMatch(/tools: tmux .* in .*exit 0$/s);
    expect(fs.existsSync(path.join(tools.dir, 'tools/out/bin/tmux'))).toBe(
      true
    );
    expect(fs.existsSync(path.join(tools.dir, 'tools/out/bin/git'))).toBe(true);
  });

  it('leaves no binaries in out/ when the link check fails, so the next run builds again', () => {
    const tools = toolsDir();
    made.splice(made.length, 0, tools.dir);

    expect(tools.run(true)).toMatch(/links outside \/usr\/lib.*exit 1$/s);
    expect(fs.existsSync(path.join(tools.dir, 'tools/out/bin/tmux'))).toBe(
      false
    );
    expect(tools.run(true)).not.toContain('already built');
  });

  it('stops on a tarball whose SHA-256 is not the pinned one, and deletes it', () => {
    const tools = toolsDir({ tamperedTmux: true });
    made.splice(made.length, 0, tools.dir);

    expect(tools.run(false)).toMatch(
      new RegExp(
        `tmux-3\\.5a\\.tar\\.gz has SHA-256 0{64}, expected ${pinned(
          'TMUX'
        )}.*exit 1$`,
        's'
      )
    );
    expect(
      fs.existsSync(path.join(tools.dir, 'tools/.work/tmux-3.5a.tar.gz'))
    ).toBe(false);
    expect(fs.existsSync(path.join(tools.dir, 'tools/out'))).toBe(false);
  });
});
