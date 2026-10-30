import { Image } from '@tiptap/extension-image';
import { Placeholder } from '@tiptap/extension-placeholder';
import { TableKit } from '@tiptap/extension-table';
import { Markdown } from '@tiptap/markdown';
import { EditorContent, useEditor, useEditorState } from '@tiptap/react';
import { BubbleMenu } from '@tiptap/react/menus';
import { StarterKit } from '@tiptap/starter-kit';
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';

import {
  type Autosave,
  createAutosave,
  tidyMarkdown,
} from '../shared/autosave';

/**
 * A ticket's description, edited in place as Linear's is: it's always the
 * editor, select text for a formatting bar, and every pause in typing saves.
 * Markdown in, Markdown out, so the ticket's own file (or Linear, or Jira)
 * keeps plain Markdown.
 */

const browserTimer = {
  set: (run: () => void, ms: number): unknown => window.setTimeout(run, ms),
  clear: (handle: unknown): void => {
    if (typeof handle === 'number') {
      window.clearTimeout(handle);
    }
  },
};

const Tool = ({
  label,
  on,
  onClick,
  children,
}: {
  label: string;
  on: boolean;
  onClick: () => void;
  children: ReactNode;
}) => (
  <button
    type="button"
    className={`md-bar__tool${on ? ' md-bar__tool--on' : ''}`}
    aria-label={label}
    aria-pressed={on}
    title={label}
    // Keep the selection: a mousedown here would move focus off the text.
    onMouseDown={(event) => event.preventDefault()}
    onClick={onClick}
  >
    {children}
  </button>
);

const Glyph = ({ d }: { d: string }) => (
  <svg
    width="15"
    height="15"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d={d} />
  </svg>
);

export const DescriptionEditor = ({
  ticketKey,
  markdown,
  editable,
  onSave,
}: {
  /** Which ticket: a new one starts the editor afresh. */
  ticketKey: string;
  markdown: string;
  editable: boolean;
  onSave: (markdown: string) => Promise<void>;
}) => {
  const [problem, setProblem] = useState<string | null>(null);
  /** The link being typed in the bar, while it's open. */
  const [linking, setLinking] = useState<string | null>(null);
  const saveRef = useRef(onSave);
  saveRef.current = onSave;
  const autosave = useMemo<Autosave>(
    () =>
      createAutosave(
        markdown,
        (text) =>
          saveRef.current(text).then(
            () => setProblem(null),
            (caught: unknown) => {
              setProblem(
                caught instanceof Error ? caught.message : String(caught)
              );

              throw caught;
            }
          ),
        browserTimer
      ),
    // A fresh autosave per ticket; later reads only update what's saved.
    [ticketKey]
  );

  const editor = useEditor(
    {
      extensions: [
        StarterKit.configure({
          link: { openOnClick: false, autolink: true },
        }),
        Image,
        TableKit,
        Markdown,
        Placeholder.configure({ placeholder: 'Add a description…' }),
      ],
      content: markdown,
      contentType: 'markdown',
      editable,
      // What it saved is the text as this editor writes it: a tracker's own
      // markdown (Linear's code blocks, tables) reads back a little
      // differently, and that alone is never a change.
      onCreate: ({ editor: made }) =>
        autosave.saved(tidyMarkdown(made.getMarkdown())),
      // Only what the person typed is saved: the editor tidying a document it
      // just loaded is not an edit, and must never be written back.
      onUpdate: ({ editor: changed }) => {
        if (!changed.isEditable || !changed.isFocused) {
          return;
        }

        autosave.changed(tidyMarkdown(changed.getMarkdown()));
      },
      onBlur: () => autosave.flush(),
    },
    [ticketKey]
  );

  // The page re-reads the ticket: show the source's text, unless the person
  // is typing or a save is still out (theirs is newer).
  useEffect(() => {
    if (
      editor === null ||
      editor.isDestroyed ||
      editor.isFocused ||
      autosave.busy()
    ) {
      return;
    }

    if (tidyMarkdown(editor.getMarkdown()) !== tidyMarkdown(markdown)) {
      editor.commands.setContent(markdown, {
        contentType: 'markdown',
        emitUpdate: false,
      });
    }

    // As this editor writes it: see onCreate.
    autosave.saved(tidyMarkdown(editor.getMarkdown()));
  }, [editor, markdown, autosave]);

  useEffect(() => {
    if (editor !== null && !editor.isDestroyed) {
      editor.setEditable(editable);
    }
  }, [editor, editable]);

  // Leaving the ticket or the page saves what's waiting.
  useEffect(() => {
    const leave = (): void => autosave.flush();
    window.addEventListener('beforeunload', leave);

    return () => {
      window.removeEventListener('beforeunload', leave);
      leave();
    };
  }, [autosave]);

  const marks = useEditorState({
    editor,
    selector: ({ editor: now }) => ({
      bold: now?.isActive('bold') ?? false,
      italic: now?.isActive('italic') ?? false,
      strike: now?.isActive('strike') ?? false,
      code: now?.isActive('code') ?? false,
      link: now?.isActive('link') ?? false,
      heading: now?.isActive('heading') ?? false,
      bullets: now?.isActive('bulletList') ?? false,
      numbers: now?.isActive('orderedList') ?? false,
      quote: now?.isActive('blockquote') ?? false,
    }),
  });

  if (editor === null || editor.isDestroyed) {
    return null;
  }

  const chain = () => editor.chain().focus();

  return (
    <div className="ticket__description">
      <BubbleMenu
        editor={editor}
        className={`md-bar${linking === null ? '' : ' md-bar--linking'}`}
        shouldShow={({ editor: now, from, to }) =>
          now.isEditable && (from !== to || linking !== null)
        }
      >
        {linking !== null && (
          <input
            className="md-bar__link"
            aria-label="Link to"
            placeholder="Paste a link, then Enter"
            autoFocus
            value={linking}
            onChange={(event) => setLinking(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                setLinking(null);
                editor.commands.focus();
              }

              if (event.key === 'Enter') {
                event.preventDefault();

                if (linking.trim() !== '') {
                  chain().setLink({ href: linking.trim() }).run();
                }

                setLinking(null);
              }
            }}
            onBlur={() => setLinking(null)}
          />
        )}
        <Tool
          label="Heading"
          on={marks?.heading ?? false}
          onClick={() => chain().toggleHeading({ level: 2 }).run()}
        >
          <span className="md-bar__text">Aa</span>
        </Tool>
        <span className="md-bar__line" aria-hidden="true" />
        <Tool
          label="Bold (⌘B)"
          on={marks?.bold ?? false}
          onClick={() => chain().toggleBold().run()}
        >
          <Glyph d="M7 5h6a3.5 3.5 0 010 7H7zM7 12h7a3.5 3.5 0 010 7H7z" />
        </Tool>
        <Tool
          label="Italic (⌘I)"
          on={marks?.italic ?? false}
          onClick={() => chain().toggleItalic().run()}
        >
          <Glyph d="M14 5h-4M14 19h-4M13 5l-2 14" />
        </Tool>
        <Tool
          label="Strikethrough"
          on={marks?.strike ?? false}
          onClick={() => chain().toggleStrike().run()}
        >
          <Glyph d="M5 12h14M16 7a4 3 0 00-8 0c0 4 8 2 8 6a4 3 0 01-8 0" />
        </Tool>
        <Tool
          label="Code"
          on={marks?.code ?? false}
          onClick={() => chain().toggleCode().run()}
        >
          <Glyph d="M9 8l-4 4 4 4M15 8l4 4-4 4" />
        </Tool>
        <Tool
          label="Link"
          on={marks?.link ?? false}
          onClick={() => {
            if (editor.isActive('link')) {
              chain().unsetLink().run();

              return;
            }

            setLinking('');
          }}
        >
          <Glyph d="M10 14a4 4 0 006 0l3-3a4 4 0 00-6-6l-1 1M14 10a4 4 0 00-6 0l-3 3a4 4 0 006 6l1-1" />
        </Tool>
        <span className="md-bar__line" aria-hidden="true" />
        <Tool
          label="Quote"
          on={marks?.quote ?? false}
          onClick={() => chain().toggleBlockquote().run()}
        >
          <Glyph d="M7 7h4v4H8l-1 4M14 7h4v4h-3l-1 4" />
        </Tool>
        <Tool
          label="Bulleted list"
          on={marks?.bullets ?? false}
          onClick={() => chain().toggleBulletList().run()}
        >
          <Glyph d="M9 6h11M9 12h11M9 18h11M4.5 6h.01M4.5 12h.01M4.5 18h.01" />
        </Tool>
        <Tool
          label="Numbered list"
          on={marks?.numbers ?? false}
          onClick={() => chain().toggleOrderedList().run()}
        >
          <Glyph d="M10 6h10M10 12h10M10 18h10M4 5h1v4M4 18h2l-2-2a1 1 0 112 0" />
        </Tool>
      </BubbleMenu>
      <EditorContent editor={editor} className="md-editor" />
      {problem !== null && (
        <p className="md-editor__problem" role="alert">
          Couldn&rsquo;t save: {problem}. It tries again when you next pause.
        </p>
      )}
    </div>
  );
};
