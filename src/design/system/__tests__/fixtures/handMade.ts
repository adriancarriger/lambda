// A hand-made design system's manifest: url, publishedSha, createdAt and files, and no version.
export const HAND_MADE_MANIFEST = {
  url: 'https://claude.ai/artifact/HarvestFestivalKit7',
  namespace: 'Harvest',
  publishedSha: 'b81f04c2e',
  createdAt: '2026-03-14T09:30:00.000Z',
  files: [
    'project/README.md',
    'project/components/StallTag/README.md',
    'project/components/bundle.css',
    'project/components/bundle.js',
    'project/design-system.json',
    'project/tokens.json',
  ],
};

// A hand-made design system's sources.json: a folder entry under system, tokens, components and patterns (one copying four files).
export const HAND_MADE_SOURCES = {
  system: ['apps/festival/kit/', 'apps/festival/tools/make-kit.js'],
  tokens: ['apps/festival/ui/colours.ts', 'apps/festival/ui/spacing.ts'],
  components: {
    StallTag: 'apps/festival/ui/StallTag/StallTag.tsx',
    MapLegend: 'apps/festival/ui/MapLegend.tsx',
    VolunteerChip: 'apps/festival/ui/VolunteerChip.tsx',
  },
  patterns: {
    'PinIcon.tsx': ['apps/festival/ui/glyphs/Pin.tsx'],
    'TrailMap.tsx': [
      'apps/festival/screens/trails/Map.tsx',
      'apps/festival/screens/trails/MapKey.tsx',
      'apps/festival/screens/trails/MapPin.tsx',
      'apps/festival/screens/trails/MapDetour.tsx',
    ],
    'Benches.tsx': [
      'apps/festival/screens/benches/',
      'apps/festival/screens/benches/BenchList.tsx',
    ],
  },
};
