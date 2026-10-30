import type { LANES } from '../../pod-store';

type Lane = (typeof LANES)[number];

const LANE_NAMES: Record<Lane, string> = {
  normal: 'Normal build',
  'quick-fix': 'Quick fix',
  investigation: 'Investigation',
};

/**
 * A ticket's lane — "Quick fix", or "Investigation → Normal build" when
 * triage changes it. A glance, never read aloud.
 */
export const LaneTag = ({ lane, was }: { lane: Lane; was?: Lane }) =>
  was === undefined || was === lane ? (
    <span className="lane-tag">{LANE_NAMES[lane]}</span>
  ) : (
    <span className="lane-tag lane-tag--changed">
      {`${LANE_NAMES[was]} → ${LANE_NAMES[lane]}`}
    </span>
  );
