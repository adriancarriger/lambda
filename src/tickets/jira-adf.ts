/**
 * Atlassian Document Format (Jira's rich text) ↔ markdown, for descriptions
 * and comments.
 *
 * Supported both ways: paragraphs, headings, bullet and numbered lists, code
 * blocks, hard breaks, links, bold, italic and inline code. A markdown
 * picture (`![alt](url)`) goes to Jira as a text link to it, so pictures
 * never become media nodes. Any other node
 * (tables, panels, mentions, media…) is kept on pull as a
 * `<!-- adf:<type>:<base64 json> -->` placeholder, and `markdownToAdf` refuses
 * a placeholder rather than drop what it stands for. So is text carrying a
 * mark markdown has no syntax for (strike, underline, colour…), named by that
 * mark, italic inside a word (named `em`), and a heading holding a line
 * break.
 */

export interface AdfMark {
  type: string;
  attrs?: Record<string, unknown>;
}

export interface AdfNode {
  type: string;
  text?: string;
  attrs?: Record<string, unknown>;
  marks?: AdfMark[];
  content?: AdfNode[];
}

export interface AdfDoc {
  type: 'doc';
  version: 1;
  content: AdfNode[];
}

/** A placeholder `markdownToAdf` can't turn back into the node it stands for. */
export class UnsupportedAdfNodeError extends Error {
  constructor(readonly nodeType: string) {
    super(
      `The markdown holds a Jira "${nodeType}" (an <!-- adf:${nodeType}:… --> placeholder) that can't be converted back.`
    );
  }
}

// ── ADF → markdown ──────────────────────────────────────────────────────────

const placeholder = (node: AdfNode, name = node.type): string =>
  `<!-- adf:${name}:${Buffer.from(JSON.stringify(node)).toString(
    'base64'
  )} -->`;

const SUPPORTED_MARKS = new Set(['strong', 'em', 'code', 'link']);

const linkHref = (mark: AdfMark): string =>
  typeof mark.attrs?.href === 'string' ? mark.attrs.href : '';

/**
 * A link target, in `<…>` when a bare one would end early (at a `)` or a
 * space). `<` and `>` can't sit inside the brackets, so they're
 * percent-encoded, which names the same address.
 */
const linkTarget = (href: string): string =>
  /[()<>\s]/.test(href)
    ? `<${href.replace(/</g, '%3C').replace(/>/g, '%3E')}>`
    : href;

/**
 * Plain text with every character markdown would read as syntax escaped, so
 * `my_var_name` or `2 * 3` comes back from `markdownToAdf` as written.
 */
const escapeText = (text: string): string =>
  text.replace(/[\\`*_[\]<]/g, (char) => `\\${char}`);

/** A line that would start a heading or a list is escaped at its start. */
const escapeLineStarts = (text: string): string =>
  text
    .split('\n')
    .map((line) =>
      line
        .replace(/^(\s*)([#+-])/, (whole, space: string, char: string) =>
          char === '#' || /^\s*[+-]\s/.test(line) ? `${space}\\${char}` : whole
        )
        .replace(/^(\s*\d+)\.(?=\s)/, '$1\\.')
    )
    .join('\n');

/** The longest run of backticks in `text` (0 when it has none). */
const longestBackticks = (text: string): number =>
  Math.max(0, ...Array.from(text.matchAll(/`+/g), (run) => run[0].length));

/**
 * Inline code as CommonMark writes it: fenced by one more backtick than the
 * longest run inside, and padded with a space when it starts or ends with a
 * backtick or with a space at both ends, which a reader strips again.
 */
const inlineCode = (text: string): string => {
  const fence = '`'.repeat(longestBackticks(text) + 1);
  const pad =
    /^`|`$/.test(text) || (/^ [\s\S]* $/.test(text) && text.trim() !== '')
      ? ' '
      : '';

  return `${fence}${pad}${text}${pad}${fence}`;
};

/**
 * Wraps text in its marks, the first mark outermost, code innermost. Italic
 * is `_…_`, so bold italic is `**_…_**`, never an ambiguous `***…***`.
 */
const markText = (text: string, marks: AdfMark[]): string => {
  const code = marks.some((mark) => mark.type === 'code');
  const inner = code ? inlineCode(text) : escapeText(text);

  return marks
    .filter((mark) => mark.type !== 'code')
    .reduceRight((wrapped, mark) => {
      switch (mark.type) {
        case 'strong':
          return `**${wrapped}**`;
        case 'em':
          return `_${wrapped}_`;
        case 'link':
          return `[${wrapped}](${linkTarget(linkHref(mark))})`;
        default:
          return wrapped;
      }
    }, inner);
};

const inlineNode = (node: AdfNode): string => {
  switch (node.type) {
    case 'text': {
      const marks = node.marks ?? [];
      const unsupported = marks.find((mark) => !SUPPORTED_MARKS.has(mark.type));

      return unsupported === undefined
        ? markText(node.text ?? '', marks)
        : placeholder(node, unsupported.type);
    }
    case 'hardBreak':
      return '\n';
    default:
      return placeholder(node);
  }
};

/** Text whose outermost mark is italic, so its `_` touch its neighbours. */
const outerEm = (node: AdfNode): boolean =>
  node.type === 'text' &&
  (node.marks ?? []).find((mark) => mark.type !== 'code')?.type === 'em';

const touchesEm = (char: string | undefined): boolean =>
  char !== undefined && /[\w/]/.test(char);

/**
 * Italic against a word character or a `/` (part of a word) has no markdown
 * `markdownToAdf` reads back as italic, so it's kept as a placeholder rather
 * than come back as literal underscores.
 */
const inlineToMarkdown = (nodes: AdfNode[] = []): string => {
  const pieces = nodes.map(inlineNode);

  return escapeLineStarts(
    nodes
      .map((node, index) =>
        outerEm(node) &&
        (touchesEm(pieces[index - 1]?.at(-1)) ||
          touchesEm(pieces[index + 1]?.at(0)))
          ? placeholder(node, 'em')
          : pieces[index] ?? ''
      )
      .join('')
  );
};

const indent = (text: string, by: number): string =>
  text
    .split('\n')
    .map((line) => (line === '' ? line : `${' '.repeat(by)}${line}`))
    .join('\n');

const listItemToMarkdown = (item: AdfNode, marker: string): string => {
  const blocks = item.content ?? [];
  const rendered = blocks.reduce<string>((text, block, index) => {
    const body = blockToMarkdown(block);

    if (index === 0) {
      return body;
    }

    const separator = isList(block) ? '\n' : '\n\n';

    return `${text}${separator}${body}`;
  }, '');
  const [first = '', ...rest] = rendered.split('\n');

  return [
    `${marker}${first}`,
    ...(rest.length === 0 ? [] : [indent(rest.join('\n'), marker.length)]),
  ].join('\n');
};

const isList = (node: AdfNode): boolean =>
  node.type === 'bulletList' || node.type === 'orderedList';

const startOf = (node: AdfNode): number =>
  typeof node.attrs?.order === 'number' ? node.attrs.order : 1;

const blockToMarkdown = (node: AdfNode): string => {
  switch (node.type) {
    case 'paragraph':
      return inlineToMarkdown(node.content);
    case 'heading': {
      const level =
        typeof node.attrs?.level === 'number' ? node.attrs.level : 1;

      // A markdown heading is one line, so a break in it can't be written.
      return (node.content ?? []).some((child) => child.type === 'hardBreak')
        ? placeholder(node)
        : `${'#'.repeat(level)} ${inlineToMarkdown(node.content)}`;
    }
    case 'bulletList':
      return (node.content ?? [])
        .map((item) => listItemToMarkdown(item, '- '))
        .join('\n');
    case 'orderedList':
      return (node.content ?? [])
        .map((item, index) =>
          listItemToMarkdown(item, `${startOf(node) + index}. `)
        )
        .join('\n');
    case 'codeBlock': {
      const language =
        typeof node.attrs?.language === 'string' ? node.attrs.language : '';
      const code = (node.content ?? []).map((text) => text.text ?? '').join('');
      // Longer than any backtick run inside, so no line of the code closes it.
      const fence = '`'.repeat(Math.max(3, longestBackticks(code) + 1));

      return `${fence}${language}\n${code}\n${fence}`;
    }
    default:
      return placeholder(node);
  }
};

/** Jira's ADF as markdown. A missing description is an empty string. */
export const adfToMarkdown = (doc: AdfNode | null | undefined): string =>
  doc === null || doc === undefined
    ? ''
    : (doc.content ?? []).map(blockToMarkdown).join('\n\n');

// ── markdown → ADF ──────────────────────────────────────────────────────────

// An escaped `\<!--` is text that only looks like one.
const PLACEHOLDER = /(?<!\\)<!-- adf:([A-Za-z0-9]+):[A-Za-z0-9+/=]* -->/;
const HEADING = /^(#{1,6})\s+(.*)$/;
const FENCE = /^(`{3,})\s*([^`\s]*)\s*$/;
const LIST_ITEM = /^( *)([-*]|\d+\.)\s+(.*)$/;

const sameMarks = (a: AdfMark[], b: AdfMark[]): boolean =>
  JSON.stringify(a) === JSON.stringify(b);

const textNode = (text: string, marks: AdfMark[]): AdfNode =>
  marks.length === 0 ? { type: 'text', text } : { type: 'text', text, marks };

/** Joins neighbouring text nodes that carry the same marks. */
const mergeText = (nodes: AdfNode[]): AdfNode[] =>
  nodes.reduce<AdfNode[]>((merged, node) => {
    const last = merged.at(-1);

    if (
      last !== undefined &&
      last.type === 'text' &&
      node.type === 'text' &&
      sameMarks(last.marks ?? [], node.marks ?? [])
    ) {
      return [
        ...merged.slice(0, -1),
        { ...last, text: `${last.text ?? ''}${node.text ?? ''}` },
      ];
    }

    return [...merged, node];
  }, []);

// Groups: 1-2 code (2 its fence: a run of backticks, closed only by a run
// just as long) · 3-6 link or picture (3 starts `!` for a picture; 5 a `<…>`
// target, 6 a bare one) · 7-8 strong ·
// 9-10 em (*) · 11-12 em (_) · 13-14 placeholder · 15-16 an escaped
// character, read as itself. Neither em may touch a word character or a `/`
// outside its delimiters, so `max_retry_count`, `src/__tests__` and
// `packages/*/src/*.ts` stay text (`*` is stricter here than CommonMark,
// which lets it sit inside a word); a `*` can't open before a space or close
// after one either, so `2 * 3 * 4` stays text too.
const INLINE =
  /((?<!`)(`+)(?!`)[^\n]+?(?<!`)\2(?!`))|(!?\[((?:\\.|[^\]\\])*)\]\((?:<([^<>]*)>|([^)\s]+))\))|(\*\*((?:\\.|[^\\])+?)\*\*)|((?<![\w/])\*(?!\s)((?:\\.|[^*\\])+)(?<!\s)\*(?![\w/]))|((?<![\w/])_((?:\\.|[^_\\])+)_(?![\w/]))|(<!-- adf:([A-Za-z0-9]+):[A-Za-z0-9+/=]* -->)|(\\([\\`*_[\]<#+.-]))/g;

/**
 * `text` from `from` on, read against the whole of it, so the character
 * before a match is the one actually typed there.
 */
const parseInline = (
  text: string,
  marks: AdfMark[] = [],
  from = 0
): AdfNode[] => {
  if (from >= text.length) {
    return [];
  }

  const pattern = new RegExp(INLINE);
  pattern.lastIndex = from;
  const match = pattern.exec(text);

  if (match === null) {
    return [textNode(text.slice(from), marks)];
  }

  const before = text.slice(from, match.index);
  const head = before === '' ? [] : [textNode(before, marks)];

  return [
    ...head,
    ...inlineMatch(match, marks),
    ...parseInline(text, marks, match.index + match[0].length),
  ];
};

/** CommonMark strips one space from each end of code that has both. */
const unpadCode = (code: string): string =>
  /^ [\s\S]* $/.test(code) && code.trim() !== '' ? code.slice(1, -1) : code;

const inlineMatch = (match: RegExpExecArray, marks: AdfMark[]): AdfNode[] => {
  if (match[1] !== undefined) {
    const fence = (match[2] ?? '').length;

    return [
      textNode(unpadCode(match[1].slice(fence, -fence)), [
        ...marks,
        { type: 'code' },
      ]),
    ];
  }

  if (match[3] !== undefined) {
    const href = match[5] ?? match[6] ?? '';
    const text = match[4] ?? '';
    const link = { type: 'link', attrs: { href } };

    if (!match[3].startsWith('!')) {
      // `[](x)` links nothing: kept as typed.
      return text === ''
        ? [textNode(match[3], marks)]
        : parseInline(text, [...marks, link]);
    }

    // A picture is a text link (its alt, else its address), never a media
    // node, so a pushed picture reads back as the link it was sent as.
    return text === ''
      ? [textNode(href, [...marks, link])]
      : parseInline(text, [...marks, link]);
  }

  if (match[7] !== undefined) {
    return parseInline(match[8] ?? '', [...marks, { type: 'strong' }]);
  }

  if (match[9] !== undefined) {
    return parseInline(match[10] ?? '', [...marks, { type: 'em' }]);
  }

  if (match[11] !== undefined) {
    return parseInline(match[12] ?? '', [...marks, { type: 'em' }]);
  }

  if (match[15] !== undefined) {
    return [textNode(match[16] ?? '', marks)];
  }

  throw new UnsupportedAdfNodeError(match[14] ?? 'unknown');
};

/** One paragraph's lines: hard breaks between them. */
const inlineLines = (lines: string[]): AdfNode[] =>
  mergeText(
    lines.flatMap((line, index) => [
      ...(index === 0 ? [] : [{ type: 'hardBreak' }]),
      ...parseInline(line),
    ])
  );

const indentOf = (line: string): number =>
  line.length - line.trimStart().length;

const isBlank = (line: string): boolean => line.trim() === '';

const startsBlock = (line: string): boolean =>
  HEADING.test(line) ||
  FENCE.test(line.trim()) ||
  LIST_ITEM.test(line) ||
  PLACEHOLDER.test(line.trim());

interface Parsed {
  node: AdfNode;
  rest: string[];
}

const parseFence = (
  lines: string[],
  fence: string,
  language: string
): Parsed => {
  const body = lines.slice(1);
  // Closed by a run of backticks at least as long as the one that opened it.
  const close = body.findIndex(
    (line) => /^`+$/.test(line.trim()) && line.trim().length >= fence.length
  );
  const code = close === -1 ? body : body.slice(0, close);
  const text = code.join('\n');

  return {
    node: {
      type: 'codeBlock',
      ...(language === '' ? {} : { attrs: { language } }),
      content: text === '' ? [] : [{ type: 'text', text }],
    },
    rest: close === -1 ? [] : body.slice(close + 1),
  };
};

const parseParagraph = (lines: string[]): Parsed => {
  const end = lines.findIndex(
    (line, index) => index > 0 && (isBlank(line) || startsBlock(line))
  );
  const own = end === -1 ? lines : lines.slice(0, end);

  return {
    node: { type: 'paragraph', content: inlineLines(own) },
    rest: end === -1 ? [] : lines.slice(end),
  };
};

/** The lines of one list item: its own first line, then what's indented under it. */
const itemLines = (
  lines: string[],
  base: number
): { own: string[]; rest: string[] } => {
  const end = lines.findIndex((line, index) => {
    if (index === 0 || isBlank(line)) {
      return false;
    }

    return indentOf(line) <= base;
  });
  const taken = end === -1 ? lines : lines.slice(0, end);
  // Trailing blank lines belong to whatever comes next.
  const lastText = taken.reduce(
    (last, line, index) => (isBlank(line) ? last : index),
    0
  );

  return {
    own: taken.slice(0, lastText + 1),
    rest: [
      ...taken.slice(lastText + 1),
      ...(end === -1 ? [] : lines.slice(end)),
    ],
  };
};

const parseList = (lines: string[]): Parsed => {
  const first = LIST_ITEM.exec(lines[0] ?? '');

  if (first === null) {
    throw new Error('Not a list');
  }

  const base = (first[1] ?? '').length;
  const ordered = /\d/.test(first[2] ?? '');
  const start = ordered ? Number.parseInt(first[2] ?? '1', 10) : 1;

  const collect = (
    remaining: string[],
    items: AdfNode[]
  ): { items: AdfNode[]; rest: string[] } => {
    const nextLine = remaining.findIndex((line) => !isBlank(line));
    const head = nextLine === -1 ? undefined : remaining[nextLine];
    const match = head === undefined ? null : LIST_ITEM.exec(head);

    if (
      match === null ||
      (match[1] ?? '').length !== base ||
      /\d/.test(match[2] ?? '') !== ordered
    ) {
      return { items, rest: remaining };
    }

    const fromItem = remaining.slice(nextLine);
    const { own, rest } = itemLines(fromItem, base);
    const width = base + (match[2] ?? '').length + 1;
    const body = [
      match[3] ?? '',
      ...own
        .slice(1)
        .map((line) => line.slice(Math.min(width, indentOf(line)))),
    ];

    return collect(rest, [
      ...items,
      { type: 'listItem', content: parseBlocks(body) },
    ]);
  };

  const { items, rest } = collect(lines, []);

  return {
    node: ordered
      ? {
          type: 'orderedList',
          ...(start === 1 ? {} : { attrs: { order: start } }),
          content: items,
        }
      : { type: 'bulletList', content: items },
    rest,
  };
};

const parseBlock = (lines: string[]): Parsed => {
  const line = lines[0] ?? '';
  const trimmed = line.trim();
  const placeholderMatch = PLACEHOLDER.exec(trimmed);

  if (placeholderMatch !== null && trimmed === placeholderMatch[0]) {
    throw new UnsupportedAdfNodeError(placeholderMatch[1] ?? 'unknown');
  }

  const fence = FENCE.exec(trimmed);

  if (fence !== null) {
    return parseFence(lines, fence[1] ?? '```', fence[2] ?? '');
  }

  const heading = HEADING.exec(line);

  if (heading !== null) {
    return {
      node: {
        type: 'heading',
        attrs: { level: (heading[1] ?? '#').length },
        content: inlineLines([heading[2] ?? '']),
      },
      rest: lines.slice(1),
    };
  }

  return LIST_ITEM.test(line) ? parseList(lines) : parseParagraph(lines);
};

const parseBlocks = (lines: string[]): AdfNode[] => {
  const start = lines.findIndex((line) => !isBlank(line));

  if (start === -1) {
    return [];
  }

  const { node, rest } = parseBlock(lines.slice(start));

  return [node, ...parseBlocks(rest)];
};

/**
 * Markdown as Jira's ADF. Throws `UnsupportedAdfNodeError` on a placeholder,
 * naming the node type, rather than drop the content it stands for.
 */
export const markdownToAdf = (markdown: string): AdfDoc => ({
  type: 'doc',
  version: 1,
  content: parseBlocks(markdown.replace(/\r\n/g, '\n').split('\n')),
});

/** The node type of the first placeholder in `markdown`, if any. */
export const firstPlaceholder = (markdown: string): string | undefined =>
  PLACEHOLDER.exec(markdown)?.[1];
