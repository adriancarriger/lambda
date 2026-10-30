import {
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';

import { splitImages, withWords, wordsOf } from '../shared/images';
import type { LambdaInfo } from '../shared/types';
import { useImageDrop } from './ImageDrop';
import { ProjectDialog, type ProjectMade } from './ProjectDialog';
import { chosenProjectId, ticketShortcut } from './projects';

export interface NewPodRequest {
  text: string;
  freeform: boolean;
  /** Several ticket ids, but one pod about the first — not a batch. */
  single: boolean;
  /** The project it goes to (the menu under the box). */
  projectId?: string;
}

interface Props {
  onCreate: (request: NewPodRequest) => Promise<void>;
  lambda: LambdaInfo | undefined;
  /** A project was added or made: re-read the state. */
  onProjectsChanged: () => void;
  /** New project started the idea as a pod: open it, as a created pod is. */
  onStarted: (podId: string) => void;
  /** The project picked to start with ("Plan with Lambda" from a ticket). */
  startProjectId?: string | null;
}

/**
 * Does this key send the box? ⏎ in the box itself only: the Add a project /
 * New project dialog sits inside the section, so its keys bubble here too.
 */
export const sendsNewPod = (press: {
  key: string;
  shiftKey: boolean;
  composing: boolean;
  inBox: boolean;
}): boolean =>
  press.key === 'Enter' && !press.shiftKey && !press.composing && press.inBox;

/**
 * What the box does once a project was added or made: pick it, and for New
 * project with an idea, empty the box and open the pod it started.
 */
export const projectDone = (
  kind: 'add' | 'new',
  text: string,
  result: ProjectMade
): { chosen: string; clearBox: boolean; open: string | null } => {
  const started = kind === 'new' && text.trim() !== '';

  return {
    chosen: result.projectId,
    clearBox: started,
    open: started ? result.podId ?? null : null,
  };
};

/** `PAWNEE-12`, and a sub-ticket's `PAWNEE-2a`: its letter stays small. */
const TICKET = /\b([A-Za-z]{2,})-(\d+[a-z]?)\b/g;

/** The ticket ids in the text, in order, each once (as the server reads them). */
export const ticketIdsIn = (text: string): string[] =>
  Array.from(
    new Set(
      Array.from(
        text.matchAll(TICKET),
        (match) => `${(match[1] ?? '').toUpperCase()}-${match[2] ?? ''}`
      )
    )
  );

/** A ticket the box is about ("Chat with Lambda" on its page): attached, not typed. */
export interface AboutTicket {
  id: string;
  title: string;
}

/**
 * What a chat about a ticket starts with: the ticket, then what was typed,
 * or, with nothing typed, a summary and what to change.
 */
export const aboutTicketText = (about: AboutTicket, typed: string): string =>
  typed.trim() === ''
    ? `About ${about.id} ${about.title}: sum up this ticket, then ask me what I'd like to work out or change.`
    : `About ${about.id} ${about.title}: ${typed.trim()}`;

/** The question over the box: a different one each visit, as ChatGPT does. */
const GREETINGS = [
  'What are we building next?',
  'What should we build?',
  'Where should we start?',
  "What's on your mind?",
  "What's worth building today?",
  'Got an idea? Let’s shape it.',
  'Which ticket should we take on?',
  'What are we planning today?',
  'What should we make better?',
];

const GREETING_KEY = 'pods.greeting';
const DRAFT_KEY = 'pods.newDraft';
const ABOUT_KEY = 'pods.newAbout';

/** What was typed into the box, so a refresh doesn't lose it. */
const loadDraft = (): string => {
  try {
    return window.localStorage.getItem(DRAFT_KEY) ?? '';
  } catch {
    return '';
  }
};

const saveDraft = (text: string): void => {
  try {
    if (text.trim() === '') {
      window.localStorage.removeItem(DRAFT_KEY);
    } else {
      window.localStorage.setItem(DRAFT_KEY, text);
    }
  } catch {
    // Private mode or full: the draft just won't survive a refresh.
  }
};

const loadAbout = (): AboutTicket | null => {
  try {
    const saved: unknown = JSON.parse(
      window.localStorage.getItem(ABOUT_KEY) ?? 'null'
    );

    return typeof saved === 'object' &&
      saved !== null &&
      'id' in saved &&
      typeof saved.id === 'string' &&
      'title' in saved &&
      typeof saved.title === 'string'
      ? { id: saved.id, title: saved.title }
      : null;
  } catch {
    return null;
  }
};

const saveAbout = (about: AboutTicket | null): void => {
  try {
    if (about === null) {
      window.localStorage.removeItem(ABOUT_KEY);
    } else {
      window.localStorage.setItem(ABOUT_KEY, JSON.stringify(about));
    }
  } catch {
    // Private mode: the attached ticket just won't survive a refresh.
  }
};

/** The Lambda started: the draft (and any ticket it was about) is spent. */
export const clearNewDraft = (): void => {
  saveDraft('');
  saveAbout(null);
};

/** "Plan with Lambda": what the New ticket dialog held, typed in already. */
export const startNewDraft = (text: string): void => {
  saveDraft(text);
  saveAbout(null);
};

/** "Chat with Lambda" on a ticket: the box empty, the ticket attached. */
export const startNewAbout = (about: AboutTicket): void => {
  saveDraft('');
  saveAbout(about);
};

/** A greeting other than the one shown last time. */
const pickGreeting = (): string => {
  const last = (() => {
    try {
      return Number(window.localStorage.getItem(GREETING_KEY) ?? -1);
    } catch {
      return -1;
    }
  })();
  const others = GREETINGS.map((_, index) => index).filter(
    (index) => index !== last
  );
  const index = others[Math.floor(Math.random() * others.length)] ?? 0;

  try {
    window.localStorage.setItem(GREETING_KEY, String(index));
  } catch {
    // Private mode: it may repeat, that's all.
  }

  return GREETINGS[index] ?? GREETINGS[0] ?? '';
};

interface Suggestion {
  icon: ReactNode;
  color: string;
  label: string;
  fill: string;
}

/** A ticket's icon, in a tracker's violet. */
const TICKET_ICON: Omit<Suggestion, 'label' | 'fill'> = {
  icon: (
    <>
      <path d="M4 7a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v2.5a2.5 2.5 0 0 0 0 5V17a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-2.5a2.5 2.5 0 0 0 0-5z" />
      <path d="M9 9.5h6M9 14.5h4" />
    </>
  ),
  color: '#5e6ad2',
};

/**
 * Starting points under the box: each fills in a beginning, nothing is sent.
 * Their icons carry a little colour, as ChatGPT's do — the one place the
 * app's black-and-grey palette makes room for it. The ticket one uses the
 * project's own prefix, and isn't there when the project has none.
 */
const suggestions = (prefix: string | null | undefined): Suggestion[] => {
  const ticket = ticketShortcut(prefix);

  return [
    ...(ticket === null ? [] : [{ ...TICKET_ICON, ...ticket }]),
    {
      // A bug.
      icon: (
        <>
          <rect x="7" y="8" width="10" height="12" rx="5" />
          <path d="M9 8a3 3 0 0 1 6 0M12 12v8M4 13h3M17 13h3M5 8l2.5 2M19 8l-2.5 2M5 19l2.5-2M19 19l-2.5-2" />
        </>
      ),
      color: '#e5484d',
      label: 'Plan a few bugs together',
      fill: 'Plan these bugs together: ',
    },
    {
      // A light bulb.
      icon: (
        <>
          <path d="M9 18h6M10 21h4" />
          <path d="M12 3a6 6 0 0 0-3.6 10.8c.6.5 1.1 1.3 1.1 2.2h5c0-.9.5-1.7 1.1-2.2A6 6 0 0 0 12 3z" />
        </>
      ),
      color: '#e8a317',
      label: 'Talk through a new idea',
      fill: '',
    },
  ];
};

/**
 * "+ New planning Lambda", laid out like an empty ChatGPT chat: a question,
 * one rounded box (+ for screenshots, ↑ to send), the project it goes to,
 * and a few starting points. Whatever is written — an idea, a ticket or
 * epic, a few tickets, screenshots — starts a conversation with the dev,
 * who names it and, when it's a real planning job, proposes structured
 * planning. ⏎ sends (⇧⏎ a new line). What's typed survives a refresh until
 * it's sent.
 */
export const NewPodForm = ({
  onCreate,
  lambda,
  onProjectsChanged,
  onStarted,
  startProjectId = null,
}: Props) => {
  const [text, setText] = useState(loadDraft);
  const [about, setAbout] = useState(loadAbout);
  const [busy, setBusy] = useState(false);
  const [greeting] = useState(pickGreeting);
  const [chosen, setChosen] = useState<string | null>(startProjectId);
  const [menuOpen, setMenuOpen] = useState(false);
  const [dialog, setDialog] = useState<'add' | 'new' | null>(null);
  const box = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const { zone, over, tray, attach } = useImageDrop(text, setText);
  const words = wordsOf(text);
  const ids = ticketIdsIn(splitImages(text).text).filter(
    (id) => id !== about?.id
  );
  const ready = (text.trim() !== '' || about !== null) && !busy;
  const projects = lambda?.projects ?? [];
  // A new idea goes to the last project used; the menu changes it.
  const projectId = chosenProjectId(chosen, lambda);
  const project = projects.find((candidate) => candidate.id === projectId);

  useEffect(() => saveDraft(text), [text]);
  useEffect(() => saveAbout(about), [about]);

  // The box grows with what's in it, up to a point (then it scrolls).
  useLayoutEffect(() => {
    const area = box.current;

    if (area !== null) {
      area.style.height = 'auto';
      area.style.height = `${Math.min(area.scrollHeight, 240)}px`;
    }
  }, [words]);

  // Any click elsewhere closes the project menu.
  useEffect(() => {
    if (!menuOpen) {
      return undefined;
    }

    const close = (): void => setMenuOpen(false);
    window.addEventListener('click', close);

    return () => window.removeEventListener('click', close);
  }, [menuOpen]);

  const submit = (): void => {
    if (!ready) {
      return;
    }

    setBusy(true);
    onCreate({
      text: about === null ? text.trim() : aboutTicketText(about, text),
      freeform: true,
      single: false,
      ...(projectId === null ? {} : { projectId }),
    }).finally(() => setBusy(false));
  };

  const onKey = (event: KeyboardEvent<HTMLElement>): void => {
    if (
      sendsNewPod({
        key: event.key,
        shiftKey: event.shiftKey,
        composing: event.nativeEvent.isComposing,
        inBox: event.target === box.current,
      })
    ) {
      event.preventDefault();
      submit();
    }
  };

  const start = (fill: string): void => {
    setText(withWords(text, fill));
    window.requestAnimationFrame(() => {
      const area = box.current;
      area?.focus();
      area?.setSelectionRange(fill.length, fill.length);
    });
  };

  return (
    <section className="new-chat" onKeyDown={onKey}>
      <h2 className="new-chat__ask">
        {about === null ? greeting : 'Let’s talk about this ticket.'}
      </h2>
      <div
        className={`new-chat__box${over ? ' new-chat__box--over' : ''}${
          words.includes('\n') ||
          words.length > 60 ||
          tray !== null ||
          about !== null
            ? ' new-chat__box--tall'
            : ''
        }${about === null ? '' : ' new-chat__box--about'}`}
        {...zone}
      >
        {about !== null && (
          <span className="new-chat__about">
            <svg
              viewBox="0 0 24 24"
              width="14"
              height="14"
              aria-hidden="true"
              style={{ color: TICKET_ICON.color }}
              className="new-chat__suggestion-icon"
            >
              {TICKET_ICON.icon}
            </svg>
            <span className="new-chat__about-text">
              {about.id} {about.title}
            </span>
            <button
              type="button"
              className="new-chat__about-remove"
              aria-label={`Not about ${about.id}`}
              title="Not about this ticket"
              onClick={() => {
                setAbout(null);
                box.current?.focus();
              }}
            >
              ×
            </button>
          </span>
        )}
        <textarea
          ref={box}
          autoFocus
          rows={1}
          value={words}
          disabled={busy}
          placeholder={
            about === null
              ? 'Ask Lambda…'
              : `What do you want to work out about ${about.title}?`
          }
          aria-label="What to plan"
          onChange={(event) => setText(withWords(text, event.target.value))}
        />
        {tray}
        <div className="new-chat__controls">
          <button
            type="button"
            className="new-chat__icon"
            title="Attach screenshots (or drop or paste them)"
            aria-label="Attach screenshots"
            onClick={() => picker.current?.click()}
          >
            +
          </button>
          <input
            ref={picker}
            type="file"
            accept="image/*"
            multiple
            hidden
            onChange={(event) => {
              attach(Array.from(event.target.files ?? []));
              event.target.value = '';
            }}
          />
          <button
            type="button"
            className="new-chat__send"
            title="Start (⏎)"
            aria-label="Start"
            disabled={!ready}
            onClick={submit}
          >
            ↑
          </button>
        </div>
        {over && <div className="image-drop__hint">Drop to attach</div>}
      </div>
      <div className="new-chat__project">
        <button
          type="button"
          className="chip new-chat__project-button"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          onClick={(event) => {
            event.stopPropagation();
            setMenuOpen(!menuOpen);
          }}
        >
          {project?.name ?? 'Add a codebase'} ▾
        </button>
        {menuOpen && (
          <div
            className="context-menu new-chat__project-menu"
            role="menu"
            onClick={(event) => event.stopPropagation()}
          >
            {projects.map((candidate) => (
              <button
                key={candidate.id}
                type="button"
                role="menuitemradio"
                aria-checked={candidate.id === projectId}
                onClick={() => {
                  setChosen(candidate.id);
                  setMenuOpen(false);
                }}
              >
                {candidate.id === projectId ? '✓ ' : ''}
                {candidate.name}
              </button>
            ))}
            {projects.length > 0 && <hr />}
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setMenuOpen(false);
                setDialog('add');
              }}
            >
              Add a codebase…
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setMenuOpen(false);
                setDialog('new');
              }}
            >
              New codebase…
            </button>
          </div>
        )}
      </div>
      {ids.length > 0 && (
        <div className="new-chat__ids">
          {ids.map((id) => (
            <span key={id} className="chip">
              {id}
            </span>
          ))}
        </div>
      )}
      {words.trim() === '' && about === null && !busy && (
        <ul className="new-chat__suggestions">
          {suggestions(project?.ticketPrefix).map((suggestion) => (
            <li key={suggestion.label}>
              <button type="button" onClick={() => start(suggestion.fill)}>
                <svg
                  className="new-chat__suggestion-icon"
                  viewBox="0 0 24 24"
                  aria-hidden="true"
                  style={{ color: suggestion.color }}
                >
                  {suggestion.icon}
                </svg>
                {suggestion.label}
              </button>
            </li>
          ))}
        </ul>
      )}
      {busy && <p className="muted new-chat__busy">Starting…</p>}
      {dialog !== null && (
        <ProjectDialog
          kind={dialog}
          idea={text.trim()}
          onClose={() => setDialog(null)}
          onDone={(result) => {
            const done = projectDone(dialog, text, result);
            setDialog(null);
            setChosen(done.chosen);

            // New project starts the idea as its first plan: the box is spent.
            if (done.clearBox) {
              setText('');
              clearNewDraft();
            }

            onProjectsChanged();

            if (done.open !== null) {
              onStarted(done.open);
            }
          }}
        />
      )}
    </section>
  );
};
