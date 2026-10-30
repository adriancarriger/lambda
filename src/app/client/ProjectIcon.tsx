import { iconEmoji } from '../shared/emoji';

/**
 * A tracker project's icon, as Linear draws it: its emoji, or a cube in its
 * colour when it has none Lambda can draw. And the star that favorites a
 * view, project, ticket or Lambda.
 */

export const ProjectIcon = ({
  icon,
  color,
  size = 14,
}: {
  icon: string | null | undefined;
  color: string | null | undefined;
  size?: number;
}) => {
  const emoji = iconEmoji(icon);

  if (emoji !== null) {
    return (
      <span
        className="project-icon project-icon--emoji"
        style={{ fontSize: size - 1, width: size, height: size }}
        aria-hidden="true"
      >
        {emoji}
      </span>
    );
  }

  return (
    <svg
      className="project-icon"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color ?? 'currentColor'}
      strokeWidth="1.8"
      aria-hidden="true"
    >
      <path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z" />
      <path d="M12 12l8-4.5M12 12v9M12 12L4 7.5" />
    </svg>
  );
};

/** A saved view's icon: its emoji, or Linear's stacked layers. */
export const ViewIcon = ({
  icon,
  size = 14,
}: {
  icon: string | null | undefined;
  size?: number;
}) => {
  const emoji = iconEmoji(icon);

  return emoji !== null ? (
    <span
      className="project-icon project-icon--emoji"
      style={{ fontSize: size - 1, width: size, height: size }}
      aria-hidden="true"
    >
      {emoji}
    </span>
  ) : (
    <svg
      className="project-icon"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      aria-hidden="true"
    >
      <path d="M12 4l9 5-9 5-9-5z" />
      <path d="M3 14l9 5 9-5" />
    </svg>
  );
};

export const StarButton = ({
  on,
  onToggle,
  what,
}: {
  on: boolean;
  onToggle: () => void;
  /** What's starred, for its label ("view", "project"). */
  what: string;
}) => (
  <button
    type="button"
    className={`star-button${on ? ' star-button--on' : ''}`}
    aria-pressed={on}
    aria-label={
      on ? `Remove the ${what} from favorites` : `Favorite the ${what}`
    }
    title={on ? 'Remove from favorites' : 'Add to favorites'}
    onClick={onToggle}
  >
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill={on ? 'currentColor' : 'none'}
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.8l-5.2 2.8 1-5.8-4.3-4.1 5.9-.9z" />
    </svg>
  </button>
);
