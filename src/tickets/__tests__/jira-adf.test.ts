import {
  type AdfDoc,
  type AdfMark,
  type AdfNode,
  UnsupportedAdfNodeError,
  adfToMarkdown,
  markdownToAdf,
} from '../jira-adf';

const doc = (...content: AdfNode[]): AdfDoc => ({
  type: 'doc',
  version: 1,
  content,
});

const paragraph = (...content: AdfNode[]): AdfNode => ({
  type: 'paragraph',
  content,
});

const text = (value: string, marks?: AdfMark[]): AdfNode =>
  marks === undefined
    ? { type: 'text', text: value }
    : { type: 'text', text: value, marks };

const item = (...content: AdfNode[]): AdfNode => ({
  type: 'listItem',
  content,
});

describe('ADF ↔ markdown', () => {
  it('round-trips paragraphs, a list and a link to the same ADF', () => {
    const adf = doc(
      paragraph(text('Fill the pit at Lot 48.')),
      {
        type: 'bulletList',
        content: [
          item(paragraph(text('Ask Ann Perkins'))),
          item(
            paragraph(
              text('Read '),
              text('the plan', [
                { type: 'link', attrs: { href: 'https://pawnee.gov/lot48' } },
              ])
            )
          ),
        ],
      },
      paragraph(text('Then build the park.'))
    );
    const markdown = adfToMarkdown(adf);

    expect(markdown).toBe(
      [
        'Fill the pit at Lot 48.',
        '',
        '- Ask Ann Perkins',
        '- Read [the plan](https://pawnee.gov/lot48)',
        '',
        'Then build the park.',
      ].join('\n')
    );
    expect(markdownToAdf(markdown)).toEqual(adf);
  });

  it('round-trips headings, numbered and nested lists, code and marks', () => {
    const adf = doc(
      { type: 'heading', attrs: { level: 2 }, content: [text('Plan')] },
      {
        type: 'orderedList',
        content: [
          item(paragraph(text('Survey', [{ type: 'strong' }]))),
          item(paragraph(text('Dig')), {
            type: 'bulletList',
            content: [item(paragraph(text('shovels', [{ type: 'em' }])))],
          }),
        ],
      },
      paragraph(text('Run '), text('pawnee dig', [{ type: 'code' }])),
      {
        type: 'codeBlock',
        attrs: { language: 'sh' },
        content: [text('pawnee dig --lot 48\npawnee fill')],
      },
      paragraph(
        text('Ron', [
          { type: 'strong' },
          { type: 'link', attrs: { href: 'https://pawnee.gov/ron' } },
        ])
      )
    );

    expect(markdownToAdf(adfToMarkdown(adf))).toEqual(adf);
  });

  it('round-trips plain text that looks like markdown, character for character', () => {
    const adf = doc(
      paragraph(
        text('Edit my_var_name.ts: 2 * 3 * 4, [draft], a \\ b, x < y.')
      ),
      paragraph(text('# not a heading')),
      paragraph(
        text('- not a list'),
        { type: 'hardBreak' },
        text('1. not numbered')
      ),
      paragraph(text('<!-- adf:table:abc --> is just text')),
      paragraph(text('Ron', [{ type: 'strong' }]), text(' said *hi*'))
    );

    expect(markdownToAdf(adfToMarkdown(adf))).toEqual(adf);
  });

  it('keeps a table as a placeholder, and refuses to send it back', () => {
    const table = {
      type: 'table',
      content: [{ type: 'tableRow', content: [] }],
    };
    const markdown = adfToMarkdown(doc(paragraph(text('Budget:')), table));

    expect(markdown).toMatch(/^Budget:\n\n<!-- adf:table:[A-Za-z0-9+/=]+ -->$/);
    expect(() => markdownToAdf(markdown)).toThrow(UnsupportedAdfNodeError);
    expect(() => markdownToAdf(markdown)).toThrow('"table"');
  });

  it('keeps an inline mention as a placeholder too', () => {
    const markdown = adfToMarkdown(
      doc(
        paragraph(text('Ask '), {
          type: 'mention',
          attrs: { id: 'abc', text: '@Ann' },
        })
      )
    );

    expect(markdown).toMatch(/^Ask <!-- adf:mention:/);
    expect(() => markdownToAdf(markdown)).toThrow('"mention"');
  });

  it('reads an empty description as empty', () => {
    expect(adfToMarkdown(null)).toBe('');
    expect(markdownToAdf('')).toEqual(doc());
  });
});

describe('ADF ↔ markdown, marks markdown has no syntax for', () => {
  it.each(['strike', 'underline', 'textColor', 'subsup', 'backgroundColor'])(
    'keeps text with a %s mark as a placeholder, and refuses to send it back',
    (mark) => {
      const struck = text('Lot 48', [
        { type: mark, attrs: { color: '#ff0000', type: 'sub' } },
      ]);
      const markdown = adfToMarkdown(
        doc(paragraph(text('Fill '), struck, text(' soon')))
      );

      expect(markdown).toMatch(
        new RegExp(`^Fill <!-- adf:${mark}:[A-Za-z0-9+/=]+ --> soon$`)
      );
      expect(() => markdownToAdf(markdown)).toThrow(UnsupportedAdfNodeError);
      expect(() => markdownToAdf(markdown)).toThrow(`"${mark}"`);
    }
  );
});

describe('ADF ↔ markdown, emphasis only where it is meant', () => {
  it.each([
    'max_retry_count',
    'src/__tests__/x.ts',
    'packages/*/src/*.ts',
    '2 * 3 * 4',
    '2*3*4',
  ])('reads %j as plain text', (typed) => {
    expect(markdownToAdf(typed)).toEqual(doc(paragraph(text(typed))));
  });

  it.each([
    ['_real emphasis_', 'real emphasis'],
    ['*real*', 'real'],
  ])('still reads %j as italic', (typed, inner) => {
    expect(markdownToAdf(`Say ${typed}.`)).toEqual(
      doc(paragraph(text('Say '), text(inner, [{ type: 'em' }]), text('.')))
    );
  });

  it.each([
    [
      'inside a word',
      [text('un'), text('believ', [{ type: 'em' }]), text('able')],
    ],
    ['against a path', [text('src/'), text('x', [{ type: 'em' }]), text('/y')]],
  ])(
    'keeps italic %s as a placeholder, never as literal underscores',
    (_name, content) => {
      const markdown = adfToMarkdown(doc(paragraph(...content)));

      expect(markdown).toMatch(/<!-- adf:em:[A-Za-z0-9+/=]+ -->/);
      expect(() => markdownToAdf(markdown)).toThrow(UnsupportedAdfNodeError);
      expect(() => markdownToAdf(markdown)).toThrow('"em"');
    }
  );
});

describe('ADF ↔ markdown, a heading markdown has no way to write', () => {
  it('keeps a heading holding a hard break as a placeholder, and refuses to send it back', () => {
    const markdown = adfToMarkdown(
      doc(
        {
          type: 'heading',
          attrs: { level: 2 },
          content: [text('Lot 48'), { type: 'hardBreak' }, text('the pit')],
        },
        paragraph(text('Fill it.'))
      )
    );

    expect(markdown).toMatch(
      /^<!-- adf:heading:[A-Za-z0-9+/=]+ -->\n\nFill it\.$/
    );
    expect(() => markdownToAdf(markdown)).toThrow(UnsupportedAdfNodeError);
    expect(() => markdownToAdf(markdown)).toThrow('"heading"');
  });
});

describe('ADF ↔ markdown, nested marks and awkward links', () => {
  it.each([
    [[{ type: 'strong' }, { type: 'em' }]],
    [[{ type: 'em' }, { type: 'strong' }]],
  ])('round-trips bold and italic on the same text (%j)', (marks) => {
    const adf = doc(
      paragraph(text('Ron says '), text('no', marks), text(' to taxes'))
    );

    expect(markdownToAdf(adfToMarkdown(adf))).toEqual(adf);
  });

  it.each([
    'https://en.wikipedia.org/wiki/Pawnee_(Indiana)',
    'https://pawnee.gov/a b',
    'https://pawnee.gov/lot)48',
  ])('round-trips a link to %s', (href) => {
    const adf = doc(
      paragraph(
        text('Read '),
        text('about Pawnee', [{ type: 'link', attrs: { href } }]),
        text(' first.')
      )
    );

    expect(markdownToAdf(adfToMarkdown(adf))).toEqual(adf);
  });

  describe('code holding backticks', () => {
    it.each([
      ['a backtick inside', 'a`b'],
      ['a run of two inside', 'x ``y`` z'],
      ['a backtick at the start', '`cd'],
      ['a backtick at the end', 'ls`'],
      ['spaces at both ends', ' padded '],
    ])('round-trips inline code with %s', (_name, code) => {
      const adf = doc(
        paragraph(text('Run '), text(code, [{ type: 'code' }]), text(' now'))
      );

      expect(markdownToAdf(adfToMarkdown(adf))).toEqual(adf);
    });

    it('fences a code block holding a ``` line with a longer fence', () => {
      const code = 'Write it like this:\n```\nlambda tickets list\n```\ndone';
      const adf = doc(
        {
          type: 'codeBlock',
          attrs: { language: 'md' },
          content: [text(code)],
        },
        paragraph(text('After the block.'))
      );
      const markdown = adfToMarkdown(adf);

      expect(markdown.split('\n')[0]).toBe('````md');
      expect(markdownToAdf(markdown)).toEqual(adf);
    });

    it('reads a longer fence closed only by one at least as long', () => {
      expect(markdownToAdf('````\n```\nstill code\n````')).toEqual(
        doc({ type: 'codeBlock', content: [text('```\nstill code')] })
      );
    });
  });
});
