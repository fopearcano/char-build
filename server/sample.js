// An original sample story, seeded on first run so every infographic has
// something to show. Delete it from the library whenever you like.

import { newCharacter, newStory, setPath } from '../shared/model.js';
import SAMPLE_IT from './sample-it.js';

// Translations of the sample's text, keyed by path ("story.title",
// "characters.char_mara.concept.logline", …). Option ids stay as they are.
const SAMPLE_TEXT = { it: SAMPLE_IT };

export function sampleData(lang = 'en') {
  const data = englishSample();
  const text = SAMPLE_TEXT[lang];
  if (text) {
    const byId = { story: data.stories[0], ...Object.fromEntries(data.characters.map((c) => [`characters.${c.id}`, c])) };
    for (const [path, value] of Object.entries(text)) {
      const [, root, rest] = path.match(/^(story|characters\.[^.]+)\.(.+)$/) || [];
      if (byId[root]) setPath(byId[root], rest, value);
    }
  }
  data.stories[0].sampleLang = text ? lang : 'en';
  return data;
}

function englishSample() {
  const story = newStory({
    id: 'story_undertow',
    title: 'Undertow',
    logline: 'A disgraced marine-insurance investigator returns to the fishing town she once betrayed to prove a trawler sinking was murder — and must decide whether to expose the brother who saved her life.',
    media: ['screen'],
    format: 'Limited series (6 × 60′)',
    causality: 'balanced',
    theme: 'Truth heals a community only when the truth-teller turns it on herself first.',
    coreValue: { positive: 'Justice', negative: 'Injustice' },
    genre: { primary: ['crime', 'redemption'], presentational: [], combination: 'merged' },
    world: {
      period: 'Contemporary, late autumn',
      duration: 'Three weeks before the winter storms break up the wreck',
      location: 'Kessan, a dwindling fishing port on a northern firth',
      levels: ['physical', 'social', 'personal', 'inner'],
      notes: 'A town that survives on quotas, favours and silence. Everyone owes someone; nobody writes it down.',
    },
  });

  const mara = newCharacter({
    id: 'char_mara',
    storyId: story.id,
    name: 'Mara Voss',
    color: '#1098ad',
    concept: {
      nickname: 'The Ledger (what the harbour calls her behind her back)',
      roleLabel: 'Investigator / Prodigal',
      logline: 'A fraud investigator who can smell a lie in any man’s paperwork but has built her own life on one.',
      inspiration: ['events', 'reality', 'insideOut'],
      tellingDetail: 'She still salts her tea the way her drowned father did — the only habit of Kessan she never shed.',
      magicIf: 'If a trawler sank in calm water with four men aboard, who would be sent to find out why — and what would it cost her to be the one who knows?',
      approach: 'alternating',
      inCharacter: 'I would not go back. I’d send the junior. But the junior wouldn’t know that the Marigold’s bilge alarm was rewired in 2009, because I was the one who reported it. So I go. And I make them hate me first, so it hurts less later.',
      research: ['grounded', 'bookBound'],
      researchNotes: 'Marine Accident Investigation reports; interviews with a loss adjuster; two days on a creel boat.',
    },
    cast: {
      circle: 'protagonist',
      function: 'support',
      specialRoles: ['pov', 'focal'],
      protagonistType: 'single',
      essentials: ['willpower', 'capabilities', 'underdog', 'empathy', 'intrigue', 'depth', 'change'],
      centerOfGood: 'In a town that lies to protect itself, she refuses to lie about the dead — and she is unexpectedly gentle with the drowned men’s children.',
    },
    outer: {
      explicit: {
        nameMeaning: 'Mara — “bitter”, and close to the sea; Voss is a skipper’s name everyone in Kessan still knows.',
        age: '41',
        appearance: 'Tall, wind-scoured, a diver’s shoulders; a white scar across her left palm from a mooring line at twelve.',
        wardrobe: 'Buys expensive city coats she never wears; lives in her father’s oilskin and a grey roll-neck.',
        gender: 'Woman',
        voice: 'Clipped, forensic, sardonic. Speaks in numbers and dates. Drops into the Kessan vowels when she is drunk or frightened.',
        face: 'Eyes that count exits. Smiles only with the left side of her mouth.',
        gestures: 'Taps a pen against her teeth while listening; folds receipts into tiny boats.',
        profession: 'Senior investigator, marine-insurance fraud.',
        workIdentity: 8,
        recreation: 'Free-diving alone in cold quarries.',
        home: 'A rented city flat with no pictures on the walls; in Kessan, her dead father’s house, which she refuses to sell.',
        transport: 'A company hatchback full of tide tables and wet kit.',
        knowledge: 'Hull engineering, insurance law, the tides of the firth, every family feud in Kessan.',
        ignorance: 'How to be forgiven. Why her mother left.',
        beliefs: 'People are honest only when it costs them nothing.',
        conversation: 'Weather, money, who owes whom.',
        manners: 'Scrupulously polite to the powerless; rude to anyone in a suit.',
      },
      expressed: { appearance: true, voice: true, gestures: true, profession: true, wardrobe: true },
      spectra: { sophistication: 2, sociability: -2, charisma: 3, generosity: -1, encouragement: -3, concern: 2 },
      implicit: {
        bigFive: { openness: 62, conscientiousness: 82, extraversion: 30, agreeableness: 22, rationality: 70 },
        intelligence: { iq: 8, eq: 6, creative: 5, curiosity: 9, cultural: 4 },
        habitsOfThought: 'Assumes deceit, follows money, trusts paper over people.',
        flexibility: 3,
        likes: 'Cold water, silence, a clean ledger.',
        dislikes: 'Sentiment, favours, men who call her “hen”.',
        fears: 'Being known. Open water at night.',
        outlook: -2,
        whoAreYou: '“I’m an investigator.” (She names her job, never her nature.)',
        achieve: 'To be the one person nobody can fool.',
        mustNever: 'Owe anybody anything.',
        humanNature: 'both',
        mood: 'Dry, watchful irritation.',
        temperament: 'A solemn, stubborn child who argued with the minister.',
        authority: 3,
        mirror: 'Remembers leaving Kessan as an act of principle; it was an act of shame.',
      },
      functions: ['credibility', 'intrigue'],
      setting: {
        period: 'Contemporary',
        location: 'Kessan harbour, the Marigold wreck site, her father’s house',
        levels: ['physical', 'social', 'personal', 'inner'],
        physical: 'The firth is beautiful and lethal; the wreck is breaking up before winter.',
        social: 'A town that survives on quotas and favours; she was once its girl, then its informer.',
        personal: 'Her brother Callum, her ex-lover Iona’s husband among the drowned.',
        restraints: 'In Kessan you do not go to the authorities. You do not speak ill of the dead.',
        relation: 'antagonism',
        extendedSelf: 'Her father’s oilskin and the house she won’t sell.',
        change: ['rebellion'],
        values: 'Loyalty (+) / Betrayal (−) outranks Justice / Injustice in Kessan — the reverse of her own ranking.',
      },
      expression: {
        simile: 'She works a harbour like a gull works a gutting table.',
        opposition: 'An honest liar.',
        selfAssessment: '“I don’t do sentiment.”',
        otherAssessment: 'Callum: “She’ll tell the truth about everybody but herself.”',
      },
    },
    selves: {
      social: 'Brisk, forensic investigator who wins by making men angry enough to blurt the truth.',
      personal: 'With Callum she is twelve again, the kid sister he pulled out of the water; with Iona she is cruel, because she once loved her.',
      core: 'Knows she left Kessan out of shame, not principle — and that she reported the boat fraud partly to punish her father.',
      hidden: 'Wants to be judged. Returned to Kessan to be punished, and to be forgiven, in that order.',
      variation: 'protected',
      personae: [
        { id: 'p1', with: 'Insurance bosses', axis: 'power', persona: 'Cool, numerate, contemptuous; never raises her voice.' },
        { id: 'p2', with: 'Callum', axis: 'intimacy', persona: 'Teasing, younger, physically affectionate; Kessan vowels return.' },
        { id: 'p3', with: 'Fishermen', axis: 'power', persona: 'Provocative, crude, matches their swearing.' },
      ],
    },
    inner: {
      motivations: { immortality: 2, survival: 4, balance: 9, pleasure: 2, sex: 3, power: 4, empathy: 6, more: 1, interest: 7, meaning: 6, fulfillment: 3, transcendence: 1 },
      outsideIn: 'A collapsing fishing economy; an insurer that wants a cheap ‘act of God’ verdict.',
      backstory: {
        patterns: 'A childhood of adults keeping secrets “for her own good”.',
        adolescence: 'At twelve she nearly drowned; Callum saved her. At sixteen she found her father’s second set of books.',
        identity: 'At twenty-two she reported the Voss boats for fraud and left on the night ferry.',
      },
      incitingIncident: 'The trawler Marigold sinks in calm water with four men aboard; her firm sends her because she is from Kessan.',
      incitingCharge: 'negative',
      superObjective: 'To restore justice for the drowned — and her own standing as the one who cannot be fooled.',
      objectOfDesire: 'Proof that the Marigold was scuttled for the insurance.',
      desireKind: 'physical',
      dilemma: {
        kind: 'negative',
        optionA: 'Expose Callum, who rewired the bilge pumps, and destroy the only person who ever saved her.',
        optionB: 'Bury the evidence, betray the drowned men and become her father.',
        choice: 'She gives the evidence to Iona, the widow — and lets the town judge her for it.',
      },
      pressure: { risk: 9, freedom: 8, notes: 'No one forces her hand; the insurer would happily take “act of God”.' },
      values: { courage: 3, hope: -2, love: 1, honesty: 2 },
      emotions: { love: 1, amity: -2, joy: -3, surprise: 1, pleasure: 0, courage: 2 },
      emotionStyle: 'Grief comes out as sarcasm; joy as a swim in freezing water.',
      feelings: { pride: 2, hope: -3, heart: -2, trust: -4 },
      reactions: 'When she is touched kindly she laughs, as if at a bad joke.',
      decisionPath: 'instinct',
    },
    dimensions: [
      { id: 'dim_truth', positive: 'Truthful', negative: 'Self-deceived', type: '2', level: 'core', defining: true, positiveExample: 'Exposes every lie in every logbook.', negativeExample: 'Tells herself she left town on principle.', consistent: true, variable: true, unresolvable: true },
      { id: 'dim_fear', positive: 'Fearless', negative: 'Terrified', type: '3', level: 'hidden', positiveExample: 'Dives the wreck alone at night.', negativeExample: 'Cannot let anyone stay the night.', consistent: true, variable: true },
      { id: 'dim_loyal', positive: 'Loyal', negative: 'Treacherous', type: '5', level: 'personal', positiveExample: 'Would die for Callum.', negativeExample: 'Has already informed on her family once.', consistent: true },
      { id: 'dim_tender', positive: 'Tender', negative: 'Cold', type: '1', level: 'social', positiveExample: 'Plays draughts with the drowned skipper’s son.', negativeExample: 'Tells his mother the payout figure at the funeral.' },
    ],
    complexity: {
      antagonism: { nature: 7, manmade: 4, body: 3, time: 6, social: 8, personal: 8, inner: 9 },
      antagonismNotes: { nature: 'Winter storms will break up the wreck.', social: 'The insurer and the town’s code of silence.', personal: 'Callum; Iona.', inner: 'Her need to be punished.' },
      capacity: 6,
      subconsciousDesire: 'To be caught, judged and forgiven by the town she betrayed.',
      innerConflicts: ['beliefSkepticism', 'selfOther'],
      depthTraits: ['insightOthers', 'intelligence', 'suffering', 'attention', 'skeptic', 'calm'],
      subtext: {
        text: '“I’m here for the hull, not for you.”',
        sub: 'I came back because I can’t forgive myself without you.',
        unsayable: 'She reported her father to make him look at her.',
      },
      secrets: 'She knew about the rewired pumps in 2009 and filed no report.',
    },
    arc: {
      need: 'Underlived life: she has never let herself be known, and so never been loved as she is.',
      needTypes: ['emotion', 'life'],
      potential: { iq: 8, eq: 6, willpower: 9, imagination: 5, empathy: 6, courage: 8 },
      incitingTuned: 'Only a crime in her own family could force her to turn her forensic honesty on herself.',
      seemsAtStart: 'A cold, incorruptible outsider.',
      isAtClimax: 'A frightened sister who chose truth over love — and found a way to keep both.',
      theory: 'changing',
      type: 'positive',
      dimensionId: 'dim_truth',
      from: 'Self-deception',
      to: 'Self-awareness',
      plot: 'redemption',
      lifeView: 'fate',
      reaction: 'trueSelf',
      pastEffect: 'repression',
      turningPoints: [
        { id: 't1', label: 'Arrives; town shuts its doors', charge: -2 },
        { id: 't2', label: 'Finds the rewired bilge alarm', charge: 3 },
        { id: 't3', label: 'Learns Callum did it', charge: -5 },
        { id: 't4', label: 'Iona confides in her', charge: 2 },
        { id: 't5', label: 'Wreck breaks up — evidence lost?', charge: -4 },
        { id: 't6', label: 'Gives the proof to Iona; confesses her own silence', charge: 4 },
      ],
      climax: 'On the harbour wall she reads her own 2009 silence into the record before she hands over Callum’s.',
      epiphany: 'Her honesty was always a weapon pointed outward.',
      completion: 'She stays in Kessan for the inquiry, judged and at last known.',
    },
    symbolic: {
      spectrum: 3, level: 'none', archetypes: ['outcast'], veil: 'The outcast who returns not as hero but as auditor.',
      stereotypeChecked: true, mode: 'realism',
    },
    genre: { coreCastRole: 'Antihero', subplotGenre: 'redemption', notes: 'Crime spine merged with a Redemption Plot inside her.' },
    action: {
      selfStory: {
        past: 'I was the only one in Kessan with the nerve to tell the truth.',
        present: 'I’m here to do a job.',
        future: 'One day I will be so right about everything that nobody can touch me.',
      },
      mo: { theme: 'documentary', description: 'She audits people the way she audits hulls.', twist: 'The audit is the only intimacy she allows.' },
      probability: 'If I humiliate a man in front of his crew, he will tell me the truth to win it back.',
      scenes: [
        { id: 's1', title: 'The harbour office', objective: 'Get the Marigold’s maintenance log', action: 'Shames the harbourmaster in front of the skippers', expectation: 'He’ll hand it over to save face', counteraction: 'Callum steps in and takes the log home “for safekeeping”', source: 'personal', surprise: 'Her brother is protecting someone', value: 'Truth', from: 1, to: -3, reaction: 'Laughs, buys everyone a drink' },
        { id: 's2', title: 'Night dive', objective: 'See the pump housing before the storm', action: 'Dives alone against orders', expectation: 'The hull will tell the truth', counteraction: 'The housing has been stripped', source: 'physical', surprise: 'Someone dived before her', value: 'Safety', from: 0, to: -4, reaction: 'Panic attack on the ladder' },
      ],
    },
    performance: {
      functions: ['intellect', 'empathy', 'suspense', 'puzzle', 'surprise', 'dimensionsOthers'],
      discovery: 'The forensic world of loss adjusters and the moral economy of a fishing town.',
      recognition: 'The fear that we left home for worse reasons than we admit.',
      curiosity: 8,
      concern: 7,
    },
    relationships: [
      { id: 'r1', targetId: 'char_callum', kind: 'family', effect: 'both', draws: 'Her loyalty and her treachery', dimensionId: 'dim_loyal' },
      { id: 'r2', targetId: 'char_iona', kind: 'lover', effect: 'helps', draws: 'Her tenderness — and her cruelty', dimensionId: 'dim_tender' },
      { id: 'r3', targetId: 'char_bain', kind: 'power', effect: 'hinders', draws: 'Her contempt for authority' },
    ],
  });

  const callum = newCharacter({
    id: 'char_callum',
    storyId: story.id,
    name: 'Callum Voss',
    color: '#e4572e',
    concept: { roleLabel: 'Brother / Skipper', logline: 'The big brother who saved her life and sank a boat to save the family business.' },
    cast: { circle: 'first', function: 'support', specialRoles: ['antagonist', 'foil'], foilOf: 'Mara', foilFunctions: ['morality', 'illuminate'] },
    outer: {
      explicit: { age: '46', profession: 'Skipper and owner of the last two Voss boats', voice: 'Warm, slow, funny; never finishes a sentence about money.', manners: 'Everyone’s friend, buys every round.' },
      expressed: { voice: true, manners: true },
      implicit: { bigFive: { openness: 40, conscientiousness: 35, extraversion: 85, agreeableness: 78, rationality: 45 } },
    },
    selves: { social: 'The harbour’s favourite son.', personal: 'Protective, smothering brother.', core: 'Knows he killed four men.', hidden: 'Has always resented saving her.' },
    inner: { objectOfDesire: 'Keep the insurance verdict “act of God”.', motivations: { survival: 8, empathy: 7, balance: 5, power: 4 } },
    dimensions: [
      { id: 'dim_c_protect', positive: 'Protecting', negative: 'Jeopardizing', type: '6', level: 'hidden', defining: true, positiveExample: 'Pulled Mara from the water.', negativeExample: 'Sent four men out on a boat he’d rigged to sink.' },
      { id: 'dim_c_gen', positive: 'Generous', negative: 'Selfish', type: '1', level: 'social' },
    ],
    relationships: [{ id: 'r4', targetId: 'char_mara', kind: 'family', effect: 'hinders', draws: 'Her twelve-year-old self', dimensionId: 'dim_fear' }],
  });

  const iona = newCharacter({
    id: 'char_iona',
    storyId: story.id,
    name: 'Iona Reid',
    color: '#ae3ec9',
    concept: { roleLabel: 'Widow', logline: 'Mara’s first love, now the widow of the Marigold’s mate — she needs the payout and the truth, in that order.' },
    cast: { circle: 'first', function: 'support', specialRoles: ['foil'], foilOf: 'Mara', foilFunctions: ['grounds', 'sees'] },
    outer: { explicit: { age: '40', profession: 'Runs the harbour café', voice: 'Quiet; asks questions instead of answering them.' }, implicit: { bigFive: { openness: 55, conscientiousness: 70, extraversion: 45, agreeableness: 60, rationality: 75 } } },
    dimensions: [{ id: 'dim_i_grief', positive: 'Grieving', negative: 'Calculating', type: '4', level: 'personal', defining: true }],
    relationships: [{ id: 'r5', targetId: 'char_mara', kind: 'lover', effect: 'helps', draws: 'Her capacity for tenderness', dimensionId: 'dim_truth' }],
  });

  const bain = newCharacter({
    id: 'char_bain',
    storyId: story.id,
    name: 'DS Ruaridh Bain',
    color: '#5c940d',
    concept: { roleLabel: 'Local police sergeant', logline: 'The gentle obstructer: helpful in every way except the one that matters.' },
    cast: { circle: 'second', function: 'support' },
    outer: { explicit: { profession: 'Police sergeant, thirty years in Kessan', manners: 'Offers tea, loses paperwork.' } },
    symbolic: { level: 'stock', stockJob: 'Small-town cop', veil: 'He keeps bees and quotes Burns; his obstruction is love of the town.', stereotypeChecked: true },
  });

  const teague = newCharacter({
    id: 'char_teague',
    storyId: story.id,
    name: 'Alan Teague',
    color: '#f59f00',
    concept: { roleLabel: 'Insurer’s regional manager' },
    cast: { circle: 'second', function: 'service' },
    outer: { explicit: { voice: 'Speaks only in deadlines.' } },
    symbolic: { level: 'type', typeAdjective: 'The impatient' },
  });

  const harbourmaster = newCharacter({
    id: 'char_harbour',
    storyId: story.id,
    name: 'Old Duthie',
    color: '#3b5bdb',
    concept: { roleLabel: 'Harbourmaster' },
    cast: { circle: 'third', function: 'service' },
    outer: { explicit: { gestures: 'Spits before every lie.' } },
  });

  return { stories: [story], characters: [mara, callum, iona, bain, teague, harbourmaster] };
}
