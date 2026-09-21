// Source marks for cards that arrive without a picture (Ayuka, 2026-09-21 msgs
// 2036/2042): WSJ walls its pages and its RSS carries no images, so the
// pipeline never gets one. Same 13 marks the Graph uses. Matching is by
// lowercase substring so "The Wall Street Journal", "WSJ" and "Wall Street
// Journal" all resolve; unknown sources get no mark and keep the plain panel.

const LOGOS: Array<{ needles: string[]; logo: number }> = [
  { needles: ['wall street journal', 'wsj'], logo: require('../../assets/logos/wsj.png') },
  { needles: ['new york times', 'nytimes', 'nyt'], logo: require('../../assets/logos/nyt.png') },
  { needles: ['atlantic'], logo: require('../../assets/logos/atlantic.png') },
  { needles: ['bbc'], logo: require('../../assets/logos/bbc.png') },
  { needles: ['breitbart'], logo: require('../../assets/logos/breitbart.png') },
  { needles: ['cnn'], logo: require('../../assets/logos/cnn.png') },
  { needles: ['fox news', 'fox'], logo: require('../../assets/logos/fox.png') },
  { needles: ['msnbc'], logo: require('../../assets/logos/msnbc.png') },
  { needles: ['national review'], logo: require('../../assets/logos/nr.png') },
  { needles: ['politico'], logo: require('../../assets/logos/politico.png') },
  { needles: ['reuters'], logo: require('../../assets/logos/reuters.png') },
  { needles: ['vox'], logo: require('../../assets/logos/vox.png') },
  { needles: ['associated press', 'ap news'], logo: require('../../assets/logos/ap.png') },
];

export const getSourceLogo = (sourceName: string | null | undefined): number | null => {
  const name = (sourceName ?? '').trim().toLowerCase();
  if (!name) return null;
  // Exact "AP" is too short for a substring match; handle it on its own.
  if (name === 'ap') return LOGOS[LOGOS.length - 1].logo;
  const hit = LOGOS.find((entry) => entry.needles.some((needle) => name.includes(needle)));
  return hit ? hit.logo : null;
};
