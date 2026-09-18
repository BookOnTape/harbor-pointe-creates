/**
 * Where to find printable files. Each entry renders a tile in the "Find a
 * file" directory. `mono` is the monogram drawn in the tile's mark; `hue` is
 * the tile's accent. Add or reorder freely.
 *
 *   cost: 'free' | 'mixed' | 'paid'
 *   cats: keys from CATEGORIES below (first one is the primary)
 */
export const CATEGORIES = {
  everyday: 'Everyday & gadgets',
  figures: 'Figures & fan art',
  minis: 'Tabletop minis',
  engineering: 'Engineering & parts',
  science: 'Science & museums',
  search: 'Search engines',
  diy: 'Design your own',
};

export const SOURCES = [
  {
    name: 'Printables',
    url: 'https://www.printables.com',
    mono: 'Pr',
    hue: '#fa6831',
    cost: 'free',
    cats: ['everyday', 'engineering'],
    tier: 'core',
    blurb:
      'Run by Prusa. Well-curated, mostly functional: organizers, brackets, phone stands, tool holders, and a strong contest culture. My first stop for anything practical.',
  },
  {
    name: 'MakerWorld',
    url: 'https://makerworld.com',
    mono: 'Mw',
    hue: '#00ae42',
    cost: 'free',
    cats: ['everyday', 'figures'],
    tier: 'core',
    blurb:
      'Bambu Lab’s platform and the fastest-growing one. Big on toys, articulated flexis, desk gadgets, and multi-color prints. Files usually come with print profiles that just work.',
  },
  {
    name: 'Thingiverse',
    url: 'https://www.thingiverse.com',
    mono: 'Tv',
    hue: '#248bfb',
    cost: 'free',
    cats: ['everyday', 'engineering'],
    tier: 'core',
    blurb:
      'The original archive: millions of files, many from the early days. Search is rough and older models can need work, but if it exists, it is probably here. Now owned by MyMiniFactory.',
  },
  {
    name: 'Cults3D',
    url: 'https://cults3d.com',
    mono: 'Cu',
    hue: '#7b2cbf',
    cost: 'mixed',
    cats: ['figures', 'everyday'],
    tier: 'core',
    blurb:
      'Independent designers selling and sharing. The best place for anime and game fan art, cosplay props, jewelry, and decor. Many files are a few dollars; plenty are free.',
  },
  {
    name: 'MyMiniFactory',
    url: 'https://www.myminifactory.com',
    mono: 'Mf',
    hue: '#e8b84a',
    cost: 'mixed',
    cats: ['minis', 'figures'],
    tier: 'core',
    blurb:
      'Tabletop miniatures, busts, and sculptures. Every file is test-printed before it is listed. Home of Scan the World, a free library of museum statues.',
  },
  {
    name: 'Thangs',
    url: 'https://thangs.com',
    mono: 'Th',
    hue: '#4361ee',
    cost: 'mixed',
    cats: ['search', 'everyday'],
    tier: 'core',
    blurb:
      'Search across every major site at once, including by shape: upload a model and it finds similar ones. Also hosts designer memberships with exclusive files.',
  },
  {
    name: 'Yeggi',
    url: 'https://www.yeggi.com',
    mono: 'Ye',
    hue: '#ef476f',
    cost: 'free',
    cats: ['search'],
    tier: 'more',
    blurb:
      'A plain search engine for printable files across dozens of sites. Ugly, fast, thorough. Good when a name search on the big sites turns up nothing.',
  },
  {
    name: 'STLFinder',
    url: 'https://www.stlfinder.com',
    mono: 'Sf',
    hue: '#118ab2',
    cost: 'free',
    cats: ['search'],
    tier: 'more',
    blurb:
      'Another cross-site search engine. Same idea as Yeggi with a slightly different index, so try both before giving up.',
  },
  {
    name: 'GrabCAD',
    url: 'https://grabcad.com/library',
    mono: 'Gc',
    hue: '#2a9d8f',
    cost: 'free',
    cats: ['engineering'],
    tier: 'more',
    blurb:
      'Engineering CAD: gears, enclosures, real assemblies, replacement parts. Files often arrive as STEP rather than STL, which is fine, I can convert them.',
  },
  {
    name: 'NASA 3D Resources',
    url: 'https://nasa3d.arc.nasa.gov/models',
    mono: 'Na',
    hue: '#fc3d21',
    cost: 'free',
    cats: ['science'],
    tier: 'more',
    blurb:
      'Public-domain models of spacecraft, rovers, asteroids, and landing sites straight from NASA. Some need scaling or supports, all of them are cool on a shelf.',
  },
  {
    name: 'Smithsonian 3D',
    url: 'https://3d.si.edu',
    mono: 'Si',
    hue: '#9b5de5',
    cost: 'free',
    cats: ['science'],
    tier: 'more',
    blurb:
      'High-resolution scans from the Smithsonian collections: fossils, skulls, artifacts, the Apollo 11 hatch. Download as STL and print a piece of a museum.',
  },
  {
    name: 'NIH 3D',
    url: 'https://3d.nih.gov',
    mono: 'Ni',
    hue: '#20a4f3',
    cost: 'free',
    cats: ['science'],
    tier: 'more',
    blurb:
      'Science and medical models: proteins, viruses, anatomy, lab equipment. Niche, but nothing else has a printable hemoglobin molecule.',
  },
  {
    name: 'Creality Cloud',
    url: 'https://www.crealitycloud.com',
    mono: 'Cc',
    hue: '#1a53ff',
    cost: 'free',
    cats: ['everyday', 'figures'],
    tier: 'more',
    blurb:
      'Creality’s take on MakerWorld. Gadgets, toys, and a lot of pop-culture fan art. App-first and a bit chaotic, but the library is large.',
  },
  {
    name: 'Pinshape',
    url: 'https://pinshape.com',
    mono: 'Ps',
    hue: '#ff5a5f',
    cost: 'mixed',
    cats: ['everyday', 'figures'],
    tier: 'more',
    blurb:
      'A smaller, friendly community with a mix of free and paid designs. Worth a look for gifts and decor that have not been printed to death elsewhere.',
  },
  {
    name: 'CGTrader',
    url: 'https://www.cgtrader.com/3d-print-models',
    mono: 'Cg',
    hue: '#f4a261',
    cost: 'paid',
    cats: ['figures'],
    tier: 'more',
    blurb:
      'A big professional marketplace with a 3D-print filter. Highly detailed statues, busts, and licensed-looking characters. Check that a listing is marked printable before buying.',
  },
  {
    name: 'Gambody',
    url: 'https://www.gambody.com',
    mono: 'Gb',
    hue: '#e63946',
    cost: 'paid',
    cats: ['figures'],
    tier: 'more',
    blurb:
      'Paid, premium video-game and movie figures, mechs, and vehicles, pre-cut into parts that print well on a home machine. Pricey, but the detail is real.',
  },
  {
    name: 'Fab365',
    url: 'https://fab365.net',
    mono: 'Fb',
    hue: '#ffd166',
    cost: 'paid',
    cats: ['figures', 'everyday'],
    tier: 'more',
    blurb:
      'Foldable, print-in-place Star Wars ships and mechs that come off the bed as one piece and unfold. A great gift print if you want something that makes people say “wait, how?”',
  },
  {
    name: 'Hero Forge',
    url: 'https://www.heroforge.com',
    mono: 'Hf',
    hue: '#c77dff',
    cost: 'paid',
    cats: ['minis', 'diy'],
    tier: 'more',
    blurb:
      'Build a custom character mini in the browser, pose it, then buy the STL. The cleanest way to get a mini of your D&D character or, honestly, of yourself.',
  },
  {
    name: 'Patreon & Tribes',
    url: 'https://www.patreon.com/search?q=stl',
    mono: 'Pa',
    hue: '#ff424d',
    cost: 'paid',
    cats: ['minis', 'figures'],
    tier: 'more',
    blurb:
      'Studios like Loot Studios, Archvillain, and countless anime sculptors release monthly packs to subscribers. If you want a specific character, the sculptor is usually here.',
  },
  {
    name: 'Etsy',
    url: 'https://www.etsy.com/search?q=stl+file',
    mono: 'Et',
    hue: '#f1641e',
    cost: 'paid',
    cats: ['figures', 'everyday'],
    tier: 'more',
    blurb:
      'Search “STL file” and you will find thousands of small sellers: cake toppers, cookie cutters, cosplay, and fan art. Buy the file, not the printed item, and send it to me.',
  },
  {
    name: 'Tinkercad',
    url: 'https://www.tinkercad.com',
    mono: 'Tc',
    hue: '#1477d1',
    cost: 'free',
    cats: ['diy'],
    tier: 'more',
    blurb:
      'Make your own in the browser by stacking shapes. Nameplates, cookie cutters, simple brackets, and “I need a thing that is exactly this big” are all a twenty-minute job.',
  },
  {
    name: 'Onshape',
    url: 'https://www.onshape.com/en/products/free',
    mono: 'On',
    hue: '#06d6a0',
    cost: 'free',
    cats: ['diy', 'engineering'],
    tier: 'more',
    blurb:
      'Real parametric CAD, free for hobbyists, runs in a browser. The step up from Tinkercad when a part has to fit something precisely. Export STL or STEP.',
  },
  {
    name: 'Scan the World',
    url: 'https://www.myminifactory.com/scantheworld',
    mono: 'Sw',
    hue: '#8d99ae',
    cost: 'free',
    cats: ['science', 'figures'],
    tier: 'more',
    blurb:
      'Thousands of statues and artifacts scanned in museums around the world, free to print. Michelangelo for your bookshelf.',
  },
];

export const COST_LABEL = { free: 'Free', mixed: 'Free + paid', paid: 'Paid' };
