// Static, read-only content that used to live inside Express route modules and
// is now needed by the client (there is no server to serve it).
//
// Two catalogues moved here:
//   1. Daily/weekly challenge definitions. The Express route hard-coded them in
//      memory and only ever wrote completions to `completed_challenges`.
//   2. AR scenario objects. `ar.routes.ts` held the full marketplace /
//      restaurant / street vocabularies inline.
//
// Both are content, not user data, so they ship in the APK rather than being
// stored in Postgres.

export const DAILY_CHALLENGES = [
  {
    id: 'daily_1',
    title: '5 Conversations',
    description: 'Have 5 exchanges with the AI tutor',
    icon: 'chatbubbles',
    xpReward: 50,
    coinReward: 25,
  },
  {
    id: 'daily_2',
    title: 'Voice Practice',
    description: 'Record 3 pronunciation attempts',
    icon: 'mic',
    xpReward: 40,
    coinReward: 20,
  },
  {
    id: 'daily_3',
    title: 'Vocabulary Review',
    description: 'Review 10 flashcards',
    icon: 'layers',
    xpReward: 30,
    coinReward: 15,
  },
  {
    id: 'daily_4',
    title: 'Streak Saver',
    description: 'Complete any lesson today',
    icon: 'flame',
    xpReward: 20,
    coinReward: 10,
  },
  {
    id: 'daily_5',
    title: 'Community Helper',
    description: 'Comment on a community post',
    icon: 'people',
    xpReward: 35,
    coinReward: 15,
  },
];

export const WEEKLY_CHALLENGES = [
  {
    id: 'weekly_1',
    title: '7-Day Warrior',
    description: 'Complete lessons 7 days this week',
    icon: 'calendar',
    xpReward: 200,
    coinReward: 100,
  },
  {
    id: 'weekly_2',
    title: '1000 XP Week',
    description: 'Earn 1000 XP in one week',
    icon: 'star',
    xpReward: 300,
    coinReward: 150,
  },
  {
    id: 'weekly_3',
    title: 'Perfect Pronunciation',
    description: 'Get 5 pronunciation scores above 80%',
    icon: 'mic',
    xpReward: 150,
    coinReward: 75,
  },
  {
    id: 'weekly_4',
    title: 'Community Star',
    description: 'Create 3 community posts',
    icon: 'people',
    xpReward: 100,
    coinReward: 50,
  },
];

export const ALL_CHALLENGES = [...DAILY_CHALLENGES, ...WEEKLY_CHALLENGES];

export function findChallenge(challengeId) {
  return ALL_CHALLENGES.find((c) => c.id === challengeId) || null;
}

export const AR_SCENARIOS = [
  {
    id: 'market',
    title: 'Public Market',
    subtitle: 'Learn Bisaya words for things you see at the market',
    icon: 'cart',
    gradient: ['#10B981', '#059669'],
    objects: [
      {
        id: 'rice',
        label: 'Rice',
        bisaya: 'Bugas',
        pronunciation: 'BOO-gahs',
        usage: '"Palit ko og bugas" (I will buy rice)',
        category: 'food',
      },
      {
        id: 'fish',
        label: 'Fish',
        bisaya: 'Isda',
        pronunciation: 'is-DAH',
        usage: '"Tagpila ang isda?" (How much is the fish?)',
        category: 'food',
      },
      {
        id: 'chicken',
        label: 'Chicken',
        bisaya: 'Manok',
        pronunciation: 'mah-NOK',
        usage: '"Lutoa ang manok" (Cook the chicken)',
        category: 'food',
      },
      {
        id: 'pork',
        label: 'Pork',
        bisaya: 'Baboy',
        pronunciation: 'BAH-boy',
        usage: '"Pila kilo sa baboy?" (How much per kilo of pork?)',
        category: 'food',
      },
      {
        id: 'vegetable',
        label: 'Vegetables',
        bisaya: 'Utanon',
        pronunciation: 'oo-tah-NON',
        usage: '"Asa ang mga utanon?" (Where are the vegetables?)',
        category: 'food',
      },
      {
        id: 'fruit',
        label: 'Fruit',
        bisaya: 'Prutas',
        pronunciation: 'PROO-tahs',
        usage: '"Lami kaayo ang prutas" (The fruit is very delicious)',
        category: 'food',
      },
      {
        id: 'banana',
        label: 'Banana',
        bisaya: 'Saging',
        pronunciation: 'SAH-ging',
        usage: '"Pila ka buok saging?" (How many bananas?)',
        category: 'food',
      },
      {
        id: 'mango',
        label: 'Mango',
        bisaya: 'Mangga',
        pronunciation: 'mang-GAH',
        usage: '"Asa ang tam-is nga mangga?" (Where are the sweet mangoes?)',
        category: 'food',
      },
      {
        id: 'water',
        label: 'Water',
        bisaya: 'Tubig',
        pronunciation: 'TOO-big',
        usage: '"Palit ko og tubig" (I will buy water)',
        category: 'drink',
      },
      {
        id: 'money',
        label: 'Money',
        bisaya: 'Kwarta',
        pronunciation: 'KWAR-tah',
        usage: '"Pila imong kwarta?" (How much money do you have?)',
        category: 'general',
      },
      {
        id: 'basket',
        label: 'Basket',
        bisaya: 'Bukag',
        pronunciation: 'BOO-kag',
        usage: '"Dala og bukag" (Bring a basket)',
        category: 'general',
      },
      {
        id: 'scale',
        label: 'Scale',
        bisaya: 'Timbangan',
        pronunciation: 'tim-BANG-an',
        usage: '"Gamita ang timbangan" (Use the scale)',
        category: 'general',
      },
      {
        id: 'price',
        label: 'Price',
        bisaya: 'Presyo',
        pronunciation: 'PREH-syo',
        usage: '"Barato ra ang presyo" (The price is cheap)',
        category: 'general',
      },
      {
        id: 'discount',
        label: 'Discount',
        bisaya: 'Diskwento',
        pronunciation: 'dis-KWEN-to',
        usage: '"Naay diskwento?" (Is there a discount?)',
        category: 'general',
      },
      {
        id: 'market',
        label: 'Market',
        bisaya: 'Merkado',
        pronunciation: 'mer-KAH-do',
        usage: '"Moadto ko sa merkado" (I will go to the market)',
        category: 'place',
      },
    ],
  },
  {
    id: 'restaurant',
    title: 'Restaurant',
    subtitle: 'Bisaya phrases for dining out',
    icon: 'restaurant',
    gradient: ['#F59E0B', '#D97706'],
    objects: [
      {
        id: 'menu',
        label: 'Menu',
        bisaya: 'Menu',
        pronunciation: 'MEH-noo',
        usage: '"Pakit-a ko ang menu" (Show me the menu)',
        category: 'general',
      },
      {
        id: 'food',
        label: 'Food',
        bisaya: 'Pagkaon',
        pronunciation: 'pag-KA-on',
        usage: '"Lami ang pagkaon" (The food is delicious)',
        category: 'food',
      },
      {
        id: 'water',
        label: 'Drinking Water',
        bisaya: 'Tubig',
        pronunciation: 'TOO-big',
        usage: '"Hatagi ko og tubig" (Give me water)',
        category: 'drink',
      },
      {
        id: 'rice',
        label: 'Rice',
        bisaya: 'Kan-on',
        pronunciation: 'KAN-on',
        usage: '"Pila ka kan-on?" (How much rice?)',
        category: 'food',
      },
      {
        id: 'soup',
        label: 'Soup',
        bisaya: 'Sabaw',
        pronunciation: 'SAH-baw',
        usage: '"Init ang sabaw" (The soup is hot)',
        category: 'food',
      },
      {
        id: 'coffee',
        label: 'Coffee',
        bisaya: 'Kape',
        pronunciation: 'KAH-peh',
        usage: '"Usa ka tasa nga kape" (One cup of coffee)',
        category: 'drink',
      },
      {
        id: 'bill',
        label: 'Bill',
        bisaya: 'Bayronon',
        pronunciation: 'bay-RO-non',
        usage: '"Palihog ang bayronon" (Please, the bill)',
        category: 'general',
      },
      {
        id: 'table',
        label: 'Table',
        bisaya: 'Lamesa',
        pronunciation: 'lah-MEH-sah',
        usage: '"Pila ka lamesa?" (How many tables?)',
        category: 'general',
      },
      {
        id: 'spoon',
        label: 'Spoon',
        bisaya: 'Kutsara',
        pronunciation: 'koot-SAH-rah',
        usage: '"Hatag og kutsara" (Give a spoon)',
        category: 'general',
      },
      {
        id: 'fork',
        label: 'Fork',
        bisaya: 'Tinidor',
        pronunciation: 'tee-NEE-dor',
        usage: '"Gamit og tinidor" (Use a fork)',
        category: 'general',
      },
    ],
  },
  {
    id: 'street',
    title: 'Street & Directions',
    subtitle: 'Navigate Cebu streets with Bisaya',
    icon: 'compass',
    gradient: ['#8B5CF6', '#7C3AED'],
    objects: [
      {
        id: 'street',
        label: 'Street',
        bisaya: 'Dalan',
        pronunciation: 'DAH-lan',
        usage: '"Asa ning dalana?" (Where is this street?)',
        category: 'place',
      },
      {
        id: 'church',
        label: 'Church',
        bisaya: 'Simbahan',
        pronunciation: 'sim-BAH-han',
        usage: '"Asa ang simbahan?" (Where is the church?)',
        category: 'place',
      },
      {
        id: 'school',
        label: 'School',
        bisaya: 'Eskwelahan',
        pronunciation: 'es-kweh-LAH-han',
        usage: '"Duol ra ang eskwelahan" (The school is near)',
        category: 'place',
      },
      {
        id: 'hospital',
        label: 'Hospital',
        bisaya: 'Ospital',
        pronunciation: 'os-pee-TAL',
        usage: '"Dad-a ko sa ospital" (Bring me to the hospital)',
        category: 'place',
      },
      {
        id: 'store',
        label: 'Store',
        bisaya: 'Tindahan',
        pronunciation: 'tin-DAH-han',
        usage: '"Aga ang tindahan?" (Where is the store?)',
        category: 'place',
      },
      {
        id: 'jeepney',
        label: 'Jeepney',
        bisaya: 'Dyip',
        pronunciation: 'JEEP',
        usage: '"Musta ang dyip pa-sm?" (How to ride a jeepney to?)',
        category: 'transport',
      },
      {
        id: 'tricycle',
        label: 'Tricycle',
        bisaya: 'Traysikol',
        pronunciation: 'TRY-see-kol',
        usage: '"Pila plete sa traysikol?" (How much is the tricycle fare?)',
        category: 'transport',
      },
      {
        id: 'bus',
        label: 'Bus',
        bisaya: 'Bus',
        pronunciation: 'BOOS',
        usage: '"Asa ang bus stop?" (Where is the bus stop?)',
        category: 'transport',
      },
      {
        id: 'taxi',
        label: 'Taxi',
        bisaya: 'Taksi',
        pronunciation: 'TAHK-see',
        usage: '"Tawag og taksi" (Call a taxi)',
        category: 'transport',
      },
    ],
  },
];

export function findARScenario(id) {
  return AR_SCENARIOS.find((s) => s.id === id) || null;
}

/**
 * Best-effort match of a vision-model answer back onto a catalogue entry.
 *
 * The model is asked to answer with catalogue ids, but it sometimes returns the
 * English label or the Bisaya word instead. Matching on all three keeps
 * `analyzeARImage` returning real, tappable objects instead of bare strings.
 */
export function matchARObject(scenario, token) {
  if (!scenario || !token) return null;
  const needle = String(token).trim().toLowerCase();
  if (!needle) return null;
  return (
    scenario.objects.find((o) => o.id === needle) ||
    scenario.objects.find((o) => o.label.toLowerCase() === needle) ||
    scenario.objects.find((o) => o.bisaya.toLowerCase() === needle) ||
    scenario.objects.find((o) => needle.includes(o.id) || o.id.includes(needle)) ||
    scenario.objects.find(
      (o) => needle.includes(o.label.toLowerCase()) || o.label.toLowerCase().includes(needle)
    ) ||
    scenario.objects.find(
      (o) => needle.includes(o.bisaya.toLowerCase()) || o.bisaya.toLowerCase().includes(needle)
    ) ||
    null
  );
}