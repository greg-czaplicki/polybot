export interface SportMarketDescriptor {
  title?: string | null
  slug?: string | null
  eventSlug?: string | null
}

interface SportTagDefinition {
  tag: string
  label: string
  slugMarkers?: string[]
  keywords?: string[]
}

const SPORT_TAG_DEFINITIONS: SportTagDefinition[] = [
  {
    tag: 'nfl',
    label: 'NFL',
    slugMarkers: ['nfl-'],
    keywords: [
      'nfl',
      'super bowl',
      'afc',
      'nfc',
      'wild card',
      'divisional round',
      'conference championship',
      'packers',
      'vikings',
      'bears',
      'lions',
      'cowboys',
      'eagles',
      'commanders',
      'giants',
      'buccaneers',
      'falcons',
      'panthers',
      'saints',
      'rams',
      '49ers',
      'cardinals',
      'seahawks',
      'chiefs',
      'broncos',
      'chargers',
      'raiders',
      'dolphins',
      'patriots',
      'jets',
      'bills',
      'ravens',
      'browns',
      'steelers',
      'bengals',
      'jaguars',
      'colts',
      'titans',
      'texans',
    ],
  },
  {
    tag: 'nba',
    label: 'NBA',
    slugMarkers: ['nba-'],
    keywords: [
      'nba',
      'playoffs',
      'finals',
      'eastern conference',
      'western conference',
      'lakers',
      'clippers',
      'warriors',
      'suns',
      'kings',
      'mavericks',
      'spurs',
      'rockets',
      'grizzlies',
      'pelicans',
      'nuggets',
      'thunder',
      'timberwolves',
      'heat',
      'knicks',
      'nets',
      'celtics',
      'raptors',
      '76ers',
      'bucks',
      'bulls',
      'cavaliers',
      'pistons',
      'pacers',
      'hawks',
      'hornets',
      'magic',
      'wizards',
    ],
  },
  {
    tag: 'wnba',
    label: 'WNBA',
    slugMarkers: ['wnba-'],
    keywords: ['wnba', 'aces', 'liberty', 'lynx', 'sparks', 'mercury', 'sun'],
  },
  {
    tag: 'mlb',
    label: 'MLB',
    slugMarkers: ['mlb-'],
    keywords: [
      'mlb',
      'world series',
      'alcs',
      'nlcs',
      'baseball',
      'yankees',
      'red sox',
      'dodgers',
      'giants',
      'mets',
      'phillies',
      'braves',
      'padres',
      'orioles',
      'rangers',
      'astros',
      'cardinals',
      'cubs',
      'guardians',
      'brewers',
      'mariners',
    ],
  },
  {
    tag: 'nhl',
    label: 'NHL',
    slugMarkers: ['nhl-'],
    keywords: [
      'nhl',
      'stanley cup',
      'hockey',
      'bruins',
      'canadiens',
      'maple leafs',
      'red wings',
      'blackhawks',
      'rangers',
      'penguins',
      'oilers',
      'avalanche',
      'lightning',
      'golden knights',
    ],
  },
  {
    tag: 'ncaaf',
    label: 'College Football',
    slugMarkers: ['ncaaf-', 'cfb-', 'ncaa-'],
    keywords: ['ncaaf', 'cfb', 'college football', 'heisman', 'rose bowl', 'orange bowl'],
  },
  {
    tag: 'cfb',
    label: 'College Football',
    slugMarkers: ['cfb-'],
    keywords: ['cfb', 'college football playoff', 'cfp'],
  },
  {
    tag: 'ncaab',
    label: 'College Basketball',
    slugMarkers: ['ncaab-', 'cbb-', 'marchmadness-'],
    keywords: ['ncaab', 'cbb', 'college basketball', 'march madness', 'final four'],
  },
  {
    tag: 'mls',
    label: 'MLS',
    slugMarkers: ['mls-'],
    keywords: ['mls', 'major league soccer'],
  },
  {
    tag: 'epl',
    label: 'Premier League',
    slugMarkers: ['epl-'],
    keywords: ['premier league', 'epl', 'english premier'],
  },
  {
    tag: 'soccer',
    label: 'Soccer',
    slugMarkers: ['ucl-', 'uel-', 'prem-', 'serie-', 'laliga-', 'bundesliga-', 'liga-'],
    keywords: [
      'serie a',
      'la liga',
      'bundesliga',
      'champions league',
      'europa league',
      'world cup',
      'fa cup',
      'real madrid',
      'barcelona',
      'manchester united',
      'manchester city',
      'arsenal',
      'liverpool',
      'chelsea',
      'juventus',
      'inter milan',
      'ac milan',
      'bayern',
      'psg',
    ],
  },
  {
    tag: 'ufc',
    label: 'UFC / MMA',
    slugMarkers: ['ufc-', 'mma-'],
    keywords: ['ufc', 'mma', 'fight night', 'octagon'],
  },
  {
    tag: 'boxing',
    label: 'Boxing',
    slugMarkers: ['boxing-'],
    keywords: ['boxing', 'heavyweight title', 'welterweight'],
  },
  {
    tag: 'nascar',
    label: 'NASCAR',
    slugMarkers: ['nascar-'],
    keywords: ['nascar', 'cup series', 'daytona 500', 'talladega'],
  },
  {
    tag: 'indycar',
    label: 'IndyCar',
    slugMarkers: ['indycar-'],
    keywords: ['indycar', 'indy 500'],
  },
  {
    tag: 'f1',
    label: 'F1',
    slugMarkers: ['f1-'],
    keywords: ['f1', 'formula 1', 'grand prix'],
  },
  {
    tag: 'golf',
    label: 'Golf',
    slugMarkers: ['pga-', 'lpga-', 'golf-'],
    keywords: ['pga', 'lpga', 'masters', 'us open', 'open championship', 'ryder cup', 'golf'],
  },
  {
    tag: 'tennis',
    label: 'Tennis',
    slugMarkers: ['atp-', 'wta-'],
    keywords: ['atp', 'wta', 'wimbledon', 'roland garros', 'australian open', 'us open', 'grand slam'],
  },
  {
    tag: 'cfl',
    label: 'CFL',
    slugMarkers: ['cfl-'],
    keywords: ['cfl', 'grey cup'],
  },
  {
    tag: 'nrl',
    label: 'NRL',
    slugMarkers: ['nrl-'],
    keywords: ['nrl', 'state of origin'],
  },
]

const GENERIC_SPORT_SLUG_MARKERS = [
  'nfl-',
  'nba-',
  'wnba-',
  'mlb-',
  'nhl-',
  'cfb-',
  'cbb-',
  'ncaaf-',
  'ncaab-',
  'ncaa-',
  'mls-',
  'ucl-',
  'uel-',
  'ufc-',
  'mma-',
  'boxing-',
  'nascar-',
  'indycar-',
  'f1-',
  'pga-',
  'lpga-',
  'atp-',
  'wta-',
  'golf-',
  'prem-',
  'serie-',
  'laliga-',
  'bundesliga-',
  'liga-',
  'cfl-',
  'nrl-',
]

const SPORTS_TITLE_KEYWORDS = [
  'moneyline',
  'spread',
  'over/under',
  'points total',
  'goal line',
  'match odds',
  'fight odds',
  'grand slam',
  'playoffs',
  'regular season',
  'world cup',
  'champions league',
  'premier league',
  'serie a',
  'la liga',
  'bundesliga',
  'mls',
  'nfl',
  'nba',
  'mlb',
  'nhl',
  'wnba',
  'ufc',
  'mma',
  'boxing',
  'soccer',
  'football',
  'basketball',
  'baseball',
  'hockey',
  'golf',
  'tennis',
  'f1',
  'formula 1',
  'motogp',
  'nascar',
  'indycar',
  'mlr',
  'juventus',
  'arsenal',
  'lakers',
  'cowboys',
  'warriors',
  'celtics',
  'bruins',
  'kings',
  'giants',
  'yankees',
]

const SPORTS_EXCLUSION_KEYWORDS = [
  'primary',
  'president',
  'election',
  'senate',
  'house',
  'parliament',
  'governor',
  'mayor',
  'vote',
  'ballot',
  'poll',
  'court',
]

const VS_PATTERN = /\b(vs\.?|vs|at)\b|@/i

const SPORT_LABEL_MAP: Record<string, string> = SPORT_TAG_DEFINITIONS.reduce(
  (map, def) => {
    map[def.tag] = def.label
    return map
  },
  {} as Record<string, string>,
)

const normalizeSource = (descriptor: SportMarketDescriptor) =>
  `${descriptor.eventSlug ?? ''} ${descriptor.slug ?? ''}`
    .trim()
    .toLowerCase()

const normalizeTitle = (descriptor: SportMarketDescriptor) =>
  (descriptor.title ?? '').trim().toLowerCase()

export function detectSportTag(descriptor: SportMarketDescriptor): string | null {
  const slugSource = normalizeSource(descriptor)
  if (slugSource) {
    for (const def of SPORT_TAG_DEFINITIONS) {
      if (def.slugMarkers?.some((marker) => slugSource.includes(marker))) {
        return def.tag
      }
    }
  }

  const title = normalizeTitle(descriptor)
  if (title) {
    for (const def of SPORT_TAG_DEFINITIONS) {
      if (def.keywords?.some((keyword) => title.includes(keyword))) {
        return def.tag
      }
    }
  }

  return null
}

export function isSportsMarket(descriptor: SportMarketDescriptor): boolean {
  if (detectSportTag(descriptor)) {
    return true
  }

  const slugSource = normalizeSource(descriptor)
  if (
    slugSource &&
    GENERIC_SPORT_SLUG_MARKERS.some((marker) => slugSource.includes(marker))
  ) {
    return true
  }

  const title = normalizeTitle(descriptor)
  if (!title) {
    return false
  }

  if (SPORTS_TITLE_KEYWORDS.some((keyword) => title.includes(keyword))) {
    return true
  }

  const hasVsCue = VS_PATTERN.test(title)
  if (hasVsCue) {
    const hasPoliticalCue = SPORTS_EXCLUSION_KEYWORDS.some(
      (keyword) => slugSource.includes(keyword) || title.includes(keyword),
    )
    if (!hasPoliticalCue) {
      return true
    }
  }

  return false
}

export function getSportLabel(tag?: string | null): string | undefined {
  if (!tag) {
    return undefined
  }
  return SPORT_LABEL_MAP[tag] ?? tag.toUpperCase()
}

const ESPORTS_KEYWORDS = [
  'counter-strike',
  'cs:go',
  'csgo',
  'valorant',
  'league of legends',
  'lol',
  'dota',
  'dota 2',
  'overwatch',
  'rocket league',
  'rainbow six',
  'r6',
  'apex legends',
  'fortnite',
  'call of duty',
  'cod',
  'cod:',
  'esports',
  'egaming',
  'gaming',
  'esl',
  'iem',
  'blast',
  'major',
  'championship',
  'tournament',
  'bo3',
  'bo5',
  'best of',
  'map winner',
  'map 1',
  'map 2',
  'map 3',
]

export function isEsportsMarket(descriptor: SportMarketDescriptor): boolean {
  const slugSource = normalizeSource(descriptor)
  const title = normalizeTitle(descriptor)
  
  const combined = `${slugSource} ${title}`.toLowerCase()
  
  return ESPORTS_KEYWORDS.some((keyword) => combined.includes(keyword))
}
