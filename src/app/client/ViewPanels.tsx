import { useEffect, useState } from 'react';

import type { TrackerProject } from '../../tickets/source';
import type { TicketListItem } from '../shared/building';
import {
  type SavedView,
  type Visibility,
  viewCounts,
} from '../shared/savedViews';
import { labelColour } from '../shared/ticketBoard';
import { ProjectIcon } from './ProjectIcon';
import { LineIcon } from './TicketIcons';
import { MenuButton, TicketMenu } from './TicketMenu';
import { errorText } from './loading';

/**
 * The right-hand panels of a view's and a project's pages, laid out as
 * Linear's: what it is, its properties, and how its tickets break down. And
 * the dialog that saves a list's filters as a view.
 */

const VISIBILITY_NAMES: Record<Visibility, string> = {
  personal: 'Personal',
  workspace: 'Workspace',
};

const VISIBILITY_HINTS: Record<Visibility, string> = {
  personal: 'Only you see it',
  workspace: 'Everyone in the workspace sees it',
};

const VisibilityIcon = ({ visibility }: { visibility: Visibility }) =>
  visibility === 'personal' ? (
    <LineIcon name="lock" size={13} />
  ) : (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      aria-hidden="true"
    >
      <circle cx="9" cy="9" r="3.2" />
      <path d="M3.5 19c.6-3 2.8-4.8 5.5-4.8s4.9 1.8 5.5 4.8" />
      <circle cx="16.5" cy="8" r="2.6" />
      <path d="M15.5 13.4c2.6-.2 4.6 1.4 5 4.6" />
    </svg>
  );

const COUNT_TABS = [
  { by: 'assignee', name: 'Assignees' },
  { by: 'label', name: 'Labels' },
  { by: 'project', name: 'Projects' },
] as const;

type CountBy = (typeof COUNT_TABS)[number]['by'];

/** Assignees / Labels / Projects: how many of the tickets each has. */
const Breakdown = ({
  items,
  tabs,
  projectIcon,
}: {
  items: TicketListItem[];
  tabs: readonly CountBy[];
  projectIcon: (name: string) => TrackerProject | undefined;
}) => {
  const [by, setBy] = useState<CountBy>(tabs[0] ?? 'assignee');
  const counts = viewCounts(items, by);
  const top = Math.max(1, ...counts.map((one) => one.count));

  return (
    <div className="view-panel__breakdown">
      <div className="view-panel__tabs" role="tablist">
        {COUNT_TABS.filter((tab) => tabs.includes(tab.by)).map((tab) => (
          <button
            key={tab.by}
            type="button"
            role="tab"
            aria-selected={by === tab.by}
            className={`view-panel__tab${
              by === tab.by ? ' view-panel__tab--on' : ''
            }`}
            onClick={() => setBy(tab.by)}
          >
            {tab.name}
          </button>
        ))}
      </div>
      {counts.length === 0 ? (
        <p className="muted view-panel__none">No tickets.</p>
      ) : (
        <ul className="view-panel__counts">
          {counts.map((one) => (
            <li key={one.key} className="view-panel__count">
              <span className="view-panel__count-icon" aria-hidden="true">
                {by === 'label' ? (
                  <span
                    className="tk-chip__dot"
                    style={{ background: labelColour(one.key) }}
                  />
                ) : by === 'project' ? (
                  <ProjectIcon
                    icon={projectIcon(one.key)?.icon}
                    color={
                      one.key === ''
                        ? 'var(--grey-500)'
                        : projectIcon(one.key)?.color
                    }
                    size={13}
                  />
                ) : (
                  <span
                    className={`view-panel__avatar${
                      one.key === '' ? ' view-panel__avatar--none' : ''
                    }`}
                  >
                    {one.key === '' ? '' : one.key.slice(0, 1).toUpperCase()}
                  </span>
                )}
              </span>
              <span className="view-panel__count-name">{one.label}</span>
              <span className="view-panel__bar" aria-hidden="true">
                <span style={{ width: `${(one.count / top) * 100}%` }} />
              </span>
              <span className="view-panel__count-number">{one.count}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};

/** Text that saves when it loses focus (or on Enter, for a one-liner). */
const Editable = ({
  value,
  placeholder,
  multiline,
  className,
  label,
  disabled,
  onSave,
}: {
  value: string;
  placeholder: string;
  multiline: boolean;
  className: string;
  label: string;
  disabled: boolean;
  onSave: (value: string) => void;
}) => {
  const [text, setText] = useState(value);

  useEffect(() => setText(value), [value]);

  const save = (): void => {
    if (text.trim() !== value.trim() && (multiline || text.trim() !== '')) {
      onSave(multiline ? text : text.trim());
    }
  };

  return multiline ? (
    <textarea
      className={className}
      aria-label={label}
      placeholder={placeholder}
      value={text}
      rows={2}
      disabled={disabled}
      onChange={(event) => setText(event.target.value)}
      onBlur={save}
    />
  ) : (
    <input
      className={className}
      aria-label={label}
      placeholder={placeholder}
      value={text}
      disabled={disabled}
      onChange={(event) => setText(event.target.value)}
      onBlur={save}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.currentTarget.blur();
        }

        if (event.key === 'Escape') {
          setText(value);
          event.currentTarget.blur();
        }
      }}
    />
  );
};

const VisibilityMenu = ({
  visibility,
  disabled,
  onPick,
  className,
}: {
  visibility: Visibility;
  disabled: boolean;
  onPick: (visibility: Visibility) => void;
  className: string;
}) => (
  <MenuButton
    className={className}
    label={`Visibility: ${VISIBILITY_NAMES[visibility]}`}
    disabled={disabled}
    menu={(close) => (
      <TicketMenu
        label="Visibility"
        placeholder="Visibility…"
        options={(['workspace', 'personal'] as const).map((one) => ({
          value: one,
          label: VISIBILITY_NAMES[one],
          hint: VISIBILITY_HINTS[one],
          icon: <VisibilityIcon visibility={one} />,
        }))}
        selected={[visibility]}
        onPick={(value) => {
          close();
          onPick(value === 'personal' ? 'personal' : 'workspace');
        }}
        onClose={close}
      />
    )}
  >
    <VisibilityIcon visibility={visibility} />
    <span className="tk-prop-line__text">{VISIBILITY_NAMES[visibility]}</span>
  </MenuButton>
);

export const ViewPanel = ({
  view,
  items,
  ownerName,
  projectIcon,
  onChange,
  onDelete,
}: {
  view: SavedView;
  items: TicketListItem[];
  /** The signed-in owner's name, for a view that's theirs. */
  ownerName: string;
  projectIcon: (name: string) => TrackerProject | undefined;
  onChange: (
    changes: Partial<{
      name: string;
      description: string;
      visibility: Visibility;
    }>
  ) => void;
  onDelete: () => void;
}) => {
  const [deleting, setDeleting] = useState(false);

  return (
    <aside className="view-panel" aria-label="View">
      <Editable
        className="view-panel__name"
        label="View name"
        placeholder="View name"
        value={view.name}
        multiline={false}
        disabled={false}
        onSave={(name) => onChange({ name })}
      />
      <Editable
        className="view-panel__description"
        label="Description"
        placeholder="Add a description…"
        value={view.description}
        multiline
        disabled={false}
        onSave={(description) => onChange({ description })}
      />
      <dl className="view-panel__props">
        <dt>Visibility</dt>
        <dd>
          <VisibilityMenu
            className="tk-prop-line tk-prop-line--inline"
            visibility={view.visibility}
            disabled={view.mine === false}
            onPick={(visibility) => onChange({ visibility })}
          />
        </dd>
        <dt>Owner</dt>
        <dd className="view-panel__owner">
          <span className="view-panel__avatar">
            {(view.mine === false ? view.owner : ownerName)
              .slice(0, 1)
              .toUpperCase()}
          </span>
          {view.mine === false ? view.owner : ownerName}
        </dd>
        {view.linearId !== null && (
          <>
            <dt>From</dt>
            <dd className="muted">Imported from Linear</dd>
          </>
        )}
      </dl>
      <Breakdown
        items={items}
        tabs={['assignee', 'label', 'project']}
        projectIcon={projectIcon}
      />
      <div className="view-panel__foot">
        {deleting ? (
          <>
            <span className="muted">Delete this view?</span>
            <button
              type="button"
              className="tk-button tk-button--quiet"
              onClick={() => setDeleting(false)}
            >
              Keep it
            </button>
            <button
              type="button"
              className="tk-button tk-button--danger"
              onClick={onDelete}
            >
              Delete
            </button>
          </>
        ) : (
          <button
            type="button"
            className="link-button view-panel__delete"
            onClick={() => setDeleting(true)}
          >
            Delete view
          </button>
        )}
      </div>
    </aside>
  );
};

const shortDay = (iso: string): string => {
  const day = new Date(`${iso.slice(0, 10)}T12:00:00`);

  return Number.isNaN(day.getTime())
    ? iso
    : day.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
};

export const ProjectPanel = ({
  name,
  project,
  codebase,
  items,
}: {
  name: string;
  /** The tracker's record of it; undefined while loading or for a name only tickets carry. */
  project: TrackerProject | undefined;
  codebase: string;
  items: TicketListItem[];
}) => (
  <aside className="view-panel" aria-label="Project">
    <div className="view-panel__title">
      <ProjectIcon icon={project?.icon} color={project?.color} size={18} />
      <h2>{name}</h2>
    </div>
    {(project?.description ?? '') !== '' && (
      <p className="view-panel__text">{project?.description}</p>
    )}
    <dl className="view-panel__props">
      <dt>Status</dt>
      <dd>{project?.status?.name ?? '—'}</dd>
      <dt>Progress</dt>
      <dd className="view-panel__progress">
        <span className="view-panel__bar" aria-hidden="true">
          <span
            style={{ width: `${Math.round((project?.progress ?? 0) * 100)}%` }}
          />
        </span>
        {Math.round((project?.progress ?? 0) * 100)}%
      </dd>
      <dt>Lead</dt>
      <dd>{project?.lead ?? <span className="muted">No lead</span>}</dd>
      <dt>Target date</dt>
      <dd>
        {(project?.targetDate ?? null) === null ? (
          <span className="muted">No target date</span>
        ) : (
          shortDay(project?.targetDate ?? '')
        )}
      </dd>
      <dt>Codebase</dt>
      <dd>{codebase}</dd>
    </dl>
    {(project?.url ?? null) !== null && (
      <a
        className="view-panel__link"
        href={project?.url ?? undefined}
        target="_blank"
        rel="noreferrer"
      >
        Open in Linear ↗
      </a>
    )}
    <Breakdown
      items={items}
      tabs={['assignee', 'label']}
      projectIcon={() => undefined}
    />
  </aside>
);

/** "Save as new view": its name, description and who sees it. */
export const ViewDialog = ({
  onClose,
  onSave,
}: {
  onClose: () => void;
  onSave: (fields: {
    name: string;
    description: string;
    visibility: Visibility;
  }) => Promise<void>;
}) => {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [visibility, setVisibility] = useState<Visibility>('workspace');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const save = (): void => {
    if (name.trim() === '' || busy) {
      return;
    }

    setBusy(true);
    setProblem(null);
    onSave({ name: name.trim(), description, visibility })
      .catch((caught: unknown) => setProblem(errorText(caught)))
      .finally(() => setBusy(false));
  };

  return (
    <div
      className="tk-dialog-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <div
        className="tk-dialog tk-dialog--small"
        role="dialog"
        aria-modal="true"
        aria-label="New view"
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            onClose();
          }

          if (
            event.key === 'Enter' &&
            (event.metaKey || event.target instanceof HTMLInputElement)
          ) {
            save();
          }
        }}
      >
        <header className="tk-dialog__head">
          <h2>New view</h2>
          <button
            type="button"
            className="tk-icon-button tk-icon-button--bare"
            aria-label="Close"
            onClick={onClose}
          >
            <LineIcon name="close" />
          </button>
        </header>
        <input
          className="tk-dialog__title"
          aria-label="View name"
          placeholder="View name"
          autoFocus
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
        <textarea
          className="tk-dialog__description"
          aria-label="Description"
          placeholder="Description (optional)"
          rows={2}
          value={description}
          onChange={(event) => setDescription(event.target.value)}
        />
        <div className="tk-dialog__props">
          <VisibilityMenu
            className="tk-pill"
            visibility={visibility}
            disabled={false}
            onPick={setVisibility}
          />
        </div>
        {problem !== null && <p className="tk-dialog__problem">{problem}</p>}
        <footer className="tk-dialog__foot">
          <button
            type="button"
            className="tk-button tk-button--quiet"
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            type="button"
            className="tk-button tk-button--primary"
            disabled={name.trim() === '' || busy}
            onClick={save}
          >
            Save view
          </button>
        </footer>
      </div>
    </div>
  );
};
