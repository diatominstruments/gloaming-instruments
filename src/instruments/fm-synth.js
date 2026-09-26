import { Instrument, num, choice } from '../module.js';
import { mtof, envStart, envRelease } from '../util.js';

const MAX_VOICES = 8;
/** FM index of a modulator at full level: its deviation is this × its own frequency. */
const MAX_INDEX = 20;
const OPS = [1, 2, 3, 4];

/**
 * How the four operators connect, as [from, to] pairs: `from` modulates the
 * frequency of `to`. Operators that modulate nothing are carriers, the ones
 * you hear. The shapes of the classic four-operator Yamaha algorithms, plus
 * three modulators into one carrier. Keys are stored in songs.
 */
export const FM_ALGORITHMS = Object.freeze({
  stack: [[4, 3], [3, 2], [2, 1]],
  fork: [[4, 2], [3, 2], [2, 1]],
  branch: [[4, 3], [3, 1], [2, 1]],
  trio: [[4, 1], [3, 1], [2, 1]],
  pairs: [[2, 1], [4, 3]],
  spread: [[4, 1], [4, 2], [4, 3]],
  'pair-sines': [[4, 3]],
  additive: [],
});

const carriersOf = (edges) => OPS.filter((n) => !edges.some(([from]) => from === n));

// v1 was a fixed two-operator patch: its modulator is operator 2, its
// carrier operator 1, and the default `stack` with 3 and 4 silent is the
// same graph.
const V1_NAMES = {
  ratio: 'op2Ratio', index: 'op2Level', modDecay: 'op2Decay', modSustain: 'op2Sustain',
  decay: 'op1Decay', sustain: 'op1Sustain',
};

const op = (n, { ratio, level, decay, sustain, primary = false }) => ({
  [`op${n}Ratio`]: num(0.5, 16, ratio, {
    unit: '×', primary, label: 'Ratio',
    description: `Operator ${n} pitch as a multiple of the note: whole numbers are harmonic, fractions clangorous.`,
  }),
  [`op${n}Level`]: num(0, 1, level, {
    unit: '%', primary, label: 'Level',
    description: `As a carrier, operator ${n}'s volume; as a modulator, how far it bends what it feeds (index ${MAX_INDEX} at full).`,
  }),
  [`op${n}Decay`]: num(0.01, 8, decay, {
    unit: 's', scale: 'log', label: 'Decay', description: `Operator ${n}'s fall from its peak to its sustain level.`,
  }),
  [`op${n}Sustain`]: num(0, 1, sustain, {
    unit: '%', label: 'Sustain', description: `Share of operator ${n}'s level held while the note is held.`,
  }),
});

const opGroup = (n) => ({
  id: `op${n}`, label: `Operator ${n}`,
  params: [`op${n}Ratio`, `op${n}Level`, `op${n}Decay`, `op${n}Sustain`],
  role: 'envelope',
  bind: { attack: 'attack', decay: `op${n}Decay`, sustain: `op${n}Sustain`, release: 'release', amount: `op${n}Level` },
});

/**
 * FMSynth — four-operator FM, polyphonic. Each operator is a sine at
 * `ratio` × the note frequency with its own decay/sustain envelope; the
 * `algorithm` wires them up (see FM_ALGORITHMS). A modulator's level is an
 * FM index, so its envelope is how the brightness moves; a carrier's level
 * is its volume. Carriers share the mix, so switching algorithm doesn't jump
 * in loudness.
 *
 * Attack is shared. On note off the carriers fade over `release`, while
 * modulators hold their sustain until the voice stops.
 *
 * Every param is read at note-on, except `gain`. Each note builds its own
 * short-lived oscillators (skipping silent operators and anything feeding
 * only them), so voices cost nothing while silent. Past MAX_VOICES the
 * oldest voice is stolen.
 */
export class FMSynth extends Instrument {
  static id = 'fm-synth';
  static label = 'FM Synth';
  static description = 'Four-operator FM with eight algorithms, 8 voices. Bells, electric pianos, organs, brass and metallic plucks.';
  static tags = ['keys', 'bell', 'pluck'];
  static polyphony = MAX_VOICES;
  static params = {
    algorithm: choice(Object.keys(FM_ALGORITHMS), 'stack', {
      primary: true, label: 'Algorithm',
      description: 'How the operators connect: which modulate which, and which you hear.',
      labels: {
        stack: '4 → 3 → 2 → 1',
        fork: '3 + 4 → 2 → 1',
        branch: '4 → 3 → 1, 2 → 1',
        trio: '2 + 3 + 4 → 1',
        pairs: '2 → 1, 4 → 3',
        spread: '4 → 1, 2, 3',
        'pair-sines': '4 → 3, plus 1, 2',
        additive: '1, 2, 3, 4',
      },
    }),
    ...op(1, { ratio: 1, level: 1, decay: 1.5, sustain: 0 }),
    ...op(2, { ratio: 3.5, level: 0.2, decay: 0.8, sustain: 0.1, primary: true }),
    ...op(3, { ratio: 1, level: 0, decay: 1, sustain: 0.5 }),
    ...op(4, { ratio: 2, level: 0, decay: 1, sustain: 0.5 }),
    attack: num(0.001, 2, 0.002, {
      unit: 's', scale: 'log', label: 'Attack', description: 'Rise to the peak at the start of a note, for every operator.',
    }),
    release: num(0.005, 8, 0.8, {
      unit: 's', scale: 'log', label: 'Release', description: 'Fade-out of the carriers after the note ends.',
    }),
    gain: num(0, 1, 0.3, { unit: '%', label: 'Level', description: 'Output level.' }),
  };
  static groups = [
    { id: 'algorithm', label: 'Algorithm', params: ['algorithm'] },
    ...OPS.map(opGroup),
    { id: 'env', label: 'All operators', params: ['attack', 'release'] },
    { id: 'output', label: 'Output', params: ['gain'] },
  ];
  static presets = {
    'Bell': { op2Ratio: 3.5, op2Level: 0.3, op2Decay: 1.5, op2Sustain: 0, op1Decay: 4, op1Sustain: 0, release: 2 },
    'E-piano': { op2Ratio: 1, op2Level: 0.125, op2Decay: 0.6, op2Sustain: 0.1, op1Decay: 2.5, op1Sustain: 0.3, release: 0.5 },
    'Pluck': { op2Ratio: 2, op2Level: 0.25, op2Decay: 0.15, op2Sustain: 0, op1Decay: 0.4, op1Sustain: 0, release: 0.2 },
    'Metallic': { op2Ratio: 1.41, op2Level: 0.5, op2Decay: 0.8, op2Sustain: 0.2, op1Decay: 1.5, op1Sustain: 0, release: 1 },
    // A soft body pair plus a tine pair, the high ratio giving the strike.
    'Tine piano': {
      algorithm: 'pairs',
      op1Ratio: 1, op1Level: 1, op1Decay: 3, op1Sustain: 0.2,
      op2Ratio: 1, op2Level: 0.08, op2Decay: 1.2, op2Sustain: 0.1,
      op3Ratio: 1, op3Level: 0.6, op3Decay: 0.8, op3Sustain: 0,
      op4Ratio: 14, op4Level: 0.12, op4Decay: 0.12, op4Sustain: 0,
      release: 0.6,
    },
    // Drawbars: four sines at sub, fundamental, octave and twelfth.
    'Organ': {
      algorithm: 'additive',
      op1Ratio: 0.5, op1Level: 0.8, op1Sustain: 1,
      op2Ratio: 1, op2Level: 1, op2Sustain: 1,
      op3Ratio: 2, op3Level: 0.6, op3Sustain: 1,
      op4Ratio: 3, op4Level: 0.4, op4Sustain: 1,
      attack: 0.005, release: 0.08, gain: 0.4,
    },
    'Brass': {
      algorithm: 'stack',
      op1Ratio: 1, op1Level: 1, op1Decay: 0.5, op1Sustain: 0.8,
      op2Ratio: 1, op2Level: 0.15, op2Decay: 0.5, op2Sustain: 0.5,
      op3Ratio: 1, op3Level: 0.1, op3Decay: 0.3, op3Sustain: 0.3,
      attack: 0.06, release: 0.15,
    },
    'Bass': {
      algorithm: 'fork',
      op1Ratio: 1, op1Level: 1, op1Decay: 0.8, op1Sustain: 0.4,
      op2Ratio: 1, op2Level: 0.2, op2Decay: 0.25, op2Sustain: 0.05,
      op3Ratio: 2, op3Level: 0.1, op3Decay: 0.1, op3Sustain: 0,
      op4Ratio: 0.5, op4Level: 0.05, op4Decay: 0.5, op4Sustain: 0.2,
      release: 0.1, gain: 0.4,
    },
  };

  static upgradeParams(params) {
    if (!params) return params;
    const upgraded = { ...params };
    for (const [old, name] of Object.entries(V1_NAMES)) {
      if (!(old in params) || name in params) continue;
      const v = params[old];
      upgraded[name] = old === 'index' && typeof v === 'number' ? v / MAX_INDEX : v;
    }
    return upgraded;
  }

  constructor(ctx, params) {
    super(ctx, params);
    this.voices = new Map();   // note -> voice, in start order
  }

  noteOn(note, velocity = 1, time) {
    const t = this.at(time);
    const p = this.params;
    this.#release(note, t, 0.005);
    if (this.voices.size >= MAX_VOICES) this.#release(this.voices.keys().next().value, t, 0.005);

    const edges = FM_ALGORITHMS[p.algorithm];
    const carriers = carriersOf(edges);
    const live = this.#liveOps(edges, carriers);
    if (!live.size) return;

    const hz = mtof(note);
    const out = new GainNode(this.ctx);
    const oscs = new Map();
    const envs = new Map();
    for (const n of live) {
      const opHz = hz * p[`op${n}Ratio`];
      const osc = new OscillatorNode(this.ctx, { frequency: opHz });
      const env = new GainNode(this.ctx, { gain: 0 });
      osc.connect(env);
      oscs.set(n, osc);
      envs.set(n, env);

      // A modulator's peak is a frequency deviation; a carrier's, a share
      // of the mix. Harder hits are brighter as well as louder.
      const level = p[`op${n}Level`] * velocity;
      const peak = carriers.includes(n) ? level / carriers.length : level * MAX_INDEX * opHz;
      envStart(env.gain, t, {
        attack: p.attack, decay: p[`op${n}Decay`], sustain: p[`op${n}Sustain`], peak,
      });
    }
    for (const [from, to] of edges) {
      if (live.has(from) && live.has(to)) envs.get(from).connect(oscs.get(to).frequency);
    }
    const carrierEnvs = carriers.filter((n) => live.has(n)).map((n) => envs.get(n));
    for (const env of carrierEnvs) env.connect(out);
    out.connect(this.output);

    const sources = [...oscs.values()];
    sources[0].onended = () => out.disconnect();
    for (const osc of sources) osc.start(t);
    this.voices.set(note, { sources, carrierEnvs });
  }

  noteOff(note, time) {
    this.#release(note, this.at(time), this.params.release);
  }

  allNotesOff(time) {
    const t = this.at(time);
    for (const note of [...this.voices.keys()]) this.#release(note, t, 0.005);
  }

  /**
   * Operators worth building: audible carriers, and modulators with some
   * level that feed one of those, directly or down a chain.
   */
  #liveOps(edges, carriers) {
    const live = new Set();
    const visit = (n) => {
      if (live.has(n) || !(this.params[`op${n}Level`] > 0)) return;
      live.add(n);
      for (const [from, to] of edges) if (to === n) visit(from);
    };
    carriers.forEach(visit);
    return live;
  }

  #release(note, t, release) {
    const voice = this.voices.get(note);
    if (!voice) return;
    this.voices.delete(note);
    for (const env of voice.carrierEnvs) envRelease(env.gain, t, release);
    const end = t + release * 2 + 0.05;
    for (const osc of voice.sources) osc.stop(end);
  }
}
