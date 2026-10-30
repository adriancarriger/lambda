import {
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';

/**
 * A Linear-style dropdown: a trigger, then a floating list with a type-to-
 * filter box, ↑ ↓ to move and Enter to pick. Used for every property on the
 * Tickets screen (status, priority, computer, epic, labels) and for Filter
 * and Display.
 */

export interface MenuOption {
  value: string;
  label: string;
  /** Drawn before the label: a status or priority icon, a dot. */
  icon?: ReactNode;
  /** A second, quieter line ("Any computer can take it"), or a state. */
  hint?: string;
  /** Shown at the end ("idle", "offline"). */
  trail?: string;
  disabled?: boolean;
}

export const TicketMenu = ({
  options,
  selected,
  onPick,
  onClose,
  placeholder,
  label,
  align = 'left',
  onCreate,
}: {
  options: MenuOption[];
  /** Ticked: one value, or several for a multi-pick (labels). */
  selected: string[];
  onPick: (value: string) => void;
  onClose: () => void;
  /** The filter box's placeholder ("Assign to…"). */
  placeholder: string;
  label: string;
  align?: 'left' | 'right';
  /** Offered as `Add "<typed>"` when nothing matches exactly (a new label). */
  onCreate?: (text: string) => void;
}) => {
  const [query, setQuery] = useState('');
  const [at, setAt] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const needle = query.trim().toLowerCase();
  const matching = options.filter(
    (option) =>
      needle === '' ||
      option.label.toLowerCase().includes(needle) ||
      (option.hint ?? '').toLowerCase().includes(needle)
  );
  const creatable =
    onCreate !== undefined &&
    needle !== '' &&
    !options.some((option) => option.label.toLowerCase() === needle);
  const shown: MenuOption[] = creatable
    ? [...matching, { value: `\u0000new`, label: `Add “${query.trim()}”` }]
    : matching;

  useLayoutEffect(() => input.current?.focus(), []);
  useEffect(() => setAt(0), [query]);

  // A click anywhere else closes it.
  useEffect(() => {
    const away = (event: MouseEvent): void => {
      if (
        box.current !== null &&
        event.target instanceof Node &&
        !box.current.contains(event.target)
      ) {
        onClose();
      }
    };
    window.addEventListener('mousedown', away);

    return () => window.removeEventListener('mousedown', away);
  }, [onClose]);

  const pick = (option: MenuOption | undefined): void => {
    if (option === undefined || option.disabled === true) {
      return;
    }

    if (option.value === '\u0000new') {
      onCreate?.(query.trim());

      return;
    }

    onPick(option.value);
  };

  return (
    <div
      ref={box}
      className={`ticket-menu ticket-menu--${align}`}
      role="dialog"
      aria-label={label}
      onClick={(event) => event.stopPropagation()}
    >
      <input
        ref={input}
        className="ticket-menu__filter"
        type="text"
        value={query}
        placeholder={placeholder}
        aria-label={placeholder}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          event.stopPropagation();

          if (event.key === 'Escape') {
            onClose();
          }

          if (event.key === 'ArrowDown') {
            event.preventDefault();
            setAt((now) => Math.min(now + 1, shown.length - 1));
          }

          if (event.key === 'ArrowUp') {
            event.preventDefault();
            setAt((now) => Math.max(now - 1, 0));
          }

          if (event.key === 'Enter') {
            event.preventDefault();
            pick(shown[at]);
          }
        }}
      />
      <div role="listbox" aria-label={label} className="ticket-menu__list">
        {shown.length === 0 && <p className="ticket-menu__empty">No matches</p>}
        {shown.map((option, index) => (
          <button
            key={option.value}
            type="button"
            role="option"
            aria-selected={selected.includes(option.value)}
            disabled={option.disabled}
            className={`ticket-menu__option${
              index === at ? ' ticket-menu__option--at' : ''
            }`}
            onMouseEnter={() => setAt(index)}
            onClick={() => pick(option)}
          >
            {option.icon !== undefined && (
              <span className="ticket-menu__icon">{option.icon}</span>
            )}
            <span className="ticket-menu__label">
              {option.label}
              {option.hint !== undefined && (
                <span className="ticket-menu__hint">{option.hint}</span>
              )}
            </span>
            {option.trail !== undefined && (
              <span className="ticket-menu__trail">{option.trail}</span>
            )}
            {selected.includes(option.value) && (
              <svg
                className="ticket-menu__tick"
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.2"
                role="img"
                aria-label="Selected"
              >
                <path d="M5 12l5 5 9-10" />
              </svg>
            )}
          </button>
        ))}
      </div>
    </div>
  );
};

/** A property button that opens its menu below itself. */
export const MenuButton = ({
  children,
  menu,
  className,
  label,
  disabled = false,
  title,
}: {
  children: ReactNode;
  /** The menu, given a way to close it. */
  menu: (close: () => void) => ReactNode;
  className: string;
  label: string;
  disabled?: boolean;
  title?: string;
}) => {
  const [open, setOpen] = useState(false);

  return (
    <span className="menu-anchor">
      <button
        type="button"
        className={`${className}${open ? ` ${className}--open` : ''}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={label}
        title={title}
        disabled={disabled}
        onClick={(event) => {
          event.stopPropagation();
          setOpen(!open);
        }}
      >
        {children}
      </button>
      {open && menu(() => setOpen(false))}
    </span>
  );
};
