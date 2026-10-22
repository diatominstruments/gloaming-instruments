import { Effect, num, choice } from '../module.js';
import { mtof, SMOOTH } from '../util.js';
import { MATERIALS } from '../instruments/modal-synth.js';

/**
 * What rings, as partial ratios of each chord note: a string's harmonic
 * series, a pipe closed at one end (odd harmonics only, like a clarinet),
 * and the modal synth's bar, glass and bell tables.
 */
const STRUCTURES = {
  string: [1, 2, 3, 4, 5, 6],
  pipe: [1, 3, 5, 7, 9],
  bar: MATERIALS.steel.slice(0, 5),
  glass: MATERIALS.glass,
  bell: MATERIALS.bell,
};

/**
 * Chords to tune to, as semitones above the root. Shared with the vocoder's
 * built-in carrier, and keys are stored in songs.
 */
export const CHORDS = Object.freeze({
  unison: { label: 'Root only', intervals: [0] },
  octave: { label: 'Octave', intervals: [0, 12] },
  fifth: { label: 'Fifth', intervals: [0, 7, 12] },
  major: { label: 'Major', intervals: [0, 4, 7] },
  minor: { label: 'Minor', intervals: [0, 3, 7] },
  sus4: { label: 'Sus 4', intervals: [0, 5, 7] },
  maj7: { label: 'Major 7th', intervals: [0, 4, 7, 11] },
  min7: { label: 'Minor 7th', intervals: [0, 3, 7, 10] },
});

/** CHORDS' labels, for a `chord` param. */
export const chordLabels = () => Object.fromEntries(Object.entries(CHORDS).map(([key, { label }]) => [key, label]));

/**
 * Chrome stops running a biquad soon after its input falls silent, going by
 * a tail estimate far too short at high Q, which would cut the ringing off
 * whenever the input stops. So the bank's input never quite does: it always
 * carries this much DC, about -180 dB, which a bandpass doesn't pass.
 */
const IDLE = 1e-9;
/** Partials above this share of the sample rate are muted rather than aliased. */
const TOP = 0.45;
/** Overall level of the ringing at `level` 0 dB, so pink noise comes out near its own level. */
const TRIM = 0.5;
/**
 * Each partial is scaled to pass pink noise (equal power per octave, close
 * to the long-run spectrum of most music) at the same level whatever its
 * pitch. A bandpass passes power in proportion to its bandwidth f/Q, and
 * pink noise has power density in proportion to 1/f, so the f cancels and
 * the gain goes as √Q. This is the frequency where it passes white noise
 * at unity too.
 */
const PINK_REF = 500;
/** The soft clipper's curve spans ±CLIP_RANGE; anything hotter sits at its ends. */
const CLIP_RANGE = 4;

function clipCurve() {
  const curve = new Float32Array(4096);
  for (let i = 0; i < curve.length; i++) curve[i] = Math.tanh(((i / (curve.length - 1)) * 2 - 1) * CLIP_RANGE);
  return curve;
}

/**
 * Resonator — a bank of tuned, high-Q bandpass filters that the input rings,
 * like playing into the strings of a piano with the sustain pedal down.
 * Each note of `chord` (above `root`) gets the partials of `structure`, so
 * drums, noise and speech come out pitched, in key with the song.
 *
 * `decay` is the ring time of each note's lowest partial and `damping` how
 * much sooner the upper ones die; `brightness` sets their level against
 * the fundamental. Partials alternate between two sides that `spread`
 * pans apart.
 *
 * Every partial's gain is scaled so that pink noise comes out at the same
 * power through it whatever its pitch or decay, and the bank is trimmed by the
 * partials' combined level, so neither `decay` nor `chord` jumps in
 * loudness. Steady input already in tune with the bank rings far louder
 * than noise does, so the ringing goes through a soft clipper: pushed,
 * it saturates instead of running away. `level` sets how hard.
 *
 * `root` is continuous and glides every partial with it, so it can be
 * swept like a filter. `chord` and `structure` rebuild the bank, which
 * cuts off whatever is ringing.
 */
export class Resonator extends Effect {
  static id = 'resonator';
  static label = 'Resonator';
  static description = 'Tuned strings, pipes, bars or bells that the input rings, in a chord you choose. Turns drums and noise into pitched, in-key texture.';
  static tags = ['filter', 'space', 'character'];
  static params = {
    root: num(24, 84, 48, {
      unit: 'note', primary: true, label: 'Root', description: 'The note the chord is built on. Glides when moved.',
    }),
    chord: choice(Object.keys(CHORDS), 'minor', {
      label: 'Chord', description: 'The notes above the root that ring.',
      labels: chordLabels(),
    }),
    structure: choice(Object.keys(STRUCTURES), 'string', {
      label: 'Structure', description: 'What rings, which sets the pattern of overtones on each note.',
      labels: { string: 'String', pipe: 'Pipe', bar: 'Bar', glass: 'Glass', bell: 'Bell' },
    }),
    decay: num(0.05, 8, 1.5, {
      unit: 's', scale: 'log', primary: true, label: 'Decay', description: 'Ring time of each note\'s lowest partial.',
    }),
    damping: num(0, 1, 0.4, {
      unit: '%', label: 'Damping', description: 'How much sooner the upper partials die away.',
    }),
    brightness: num(0, 1, 0.5, {
      unit: '%', label: 'Brightness', description: 'Level of the upper partials against each note\'s lowest.',
    }),
    spread: num(0, 1, 0.5, {
      unit: '%', label: 'Spread', description: 'How far apart alternate partials sit in the stereo field.',
    }),
    level: num(-24, 12, 0, {
      unit: 'dB', center: 0, label: 'Level', description: 'Level of the ringing; pushed past full scale, it saturates.',
    }),
    mix: num(0, 1, 0.4, {
      unit: '%', primary: true, label: 'Mix', description: 'Ringing against the dry signal.',
    }),
  };
  static groups = [
    { id: 'tuning', label: 'Tuning', params: ['root', 'chord', 'structure'] },
    { id: 'ring', label: 'Ring', params: ['decay', 'damping', 'brightness'] },
    { id: 'output', label: 'Output', params: ['spread', 'level', 'mix'] },
  ];
  static presets = {
    'Sympathetic strings': { chord: 'octave', structure: 'string', decay: 3, damping: 0.3, brightness: 0.55, mix: 0.3 },
    'Drum tuner': { chord: 'unison', structure: 'string', decay: 0.4, damping: 0.6, brightness: 0.35, spread: 0.2, mix: 0.5 },
    'Minor pipes': { chord: 'minor', structure: 'pipe', decay: 2, damping: 0.5, brightness: 0.4, mix: 0.45 },
    'Glass chord': { root: 60, chord: 'maj7', structure: 'glass', decay: 4, damping: 0.3, brightness: 0.6, spread: 0.8, mix: 0.35 },
    'Bell tower': { root: 43, chord: 'fifth', structure: 'bell', decay: 6, damping: 0.35, brightness: 0.6, spread: 0.7, mix: 0.4 },
    'Metal box': { root: 38, chord: 'unison', structure: 'bar', decay: 0.8, damping: 0.2, brightness: 0.7, level: 4, mix: 0.6 },
  };

  constructor(ctx, params) {
    super(ctx, params);
    const p = this.params;
    this.dry = new GainNode(ctx, { gain: 1 - p.mix });
    this.wet = new GainNode(ctx, { gain: p.mix });
    this.input.connect(this.dry).connect(this.output);

    // Mono in, plus the idle floor that keeps the filters running.
    this.mono = new GainNode(ctx, { channelCount: 1, channelCountMode: 'explicit', channelInterpretation: 'speakers' });
    this.input.connect(this.mono);
    this.idle = new ConstantSourceNode(ctx, { offset: IDLE });
    this.idle.connect(this.mono);
    this.idle.start();

    // Two sides, panned apart by `spread`, into the level and the clipper.
    this.level = new GainNode(ctx, { gain: dbToGain(p.level) / CLIP_RANGE });
    this.sides = [-1, 1].map((sign) => {
      const pan = new StereoPannerNode(ctx, { pan: sign * p.spread });
      pan.connect(this.level);
      return { pan, sign };
    });
    this.level
      .connect(new WaveShaperNode(ctx, { curve: clipCurve() }))
      .connect(this.wet)
      .connect(this.output);

    this.#build();
  }

  /** One bandpass per partial of each chord note, replacing any bank already built. */
  #build() {
    if (this.feed) {
      this.mono.disconnect(this.feed);
      for (const mode of this.modes) mode.gain.disconnect();
    }
    const { chord, structure } = this.params;
    this.feed = new GainNode(this.ctx);
    this.mono.connect(this.feed);
    this.modes = [];
    CHORDS[chord].intervals.forEach((interval, n) => {
      STRUCTURES[structure].forEach((ratio, k) => {
        const filter = new BiquadFilterNode(this.ctx, { type: 'bandpass' });
        const gain = new GainNode(this.ctx);
        this.feed.connect(filter).connect(gain).connect(this.sides[(n + k) % 2].pan);
        this.modes.push({ interval, ratio, filter, gain });
      });
    });
    this.#tune();
  }

  /**
   * Every partial's frequency, Q and gain. A bandpass's Q for a 60 dB ring
   * of t60 is πf·t60 / ln(1000), and √(fs·Q / π·PINK_REF) brings the pink
   * noise it passes back to unity (see PINK_REF). `time` undefined sets
   * values directly.
   */
  #tune(time) {
    const { root, decay, damping, brightness } = this.params;
    const fs = this.ctx.sampleRate;
    const tilt = (1 - brightness) * 2;
    const base = STRUCTURES[this.params.structure][0];
    const settings = this.modes.map(({ interval, ratio }) => {
      const hz = mtof(root + interval) * ratio;
      const relative = ratio / base;
      const audible = hz < fs * TOP;
      return {
        hz: Math.min(hz, fs * TOP),
        q: (Math.PI * hz * decay * relative ** (-damping * 2)) / Math.log(1000),
        level: audible ? Math.min(1, relative ** -tilt) : 0,
      };
    });
    const loudness = Math.sqrt(settings.reduce((sum, s) => sum + s.level ** 2, 0)) || 1;
    settings.forEach(({ hz, q, level }, i) => {
      const { filter, gain } = this.modes[i];
      set(filter.frequency, hz, time);
      set(filter.Q, q, time);
      set(gain.gain, (level * TRIM * Math.sqrt((fs * q) / (Math.PI * PINK_REF))) / loudness, time);
    });
  }

  applyParam(name, value, time) {
    switch (name) {
      case 'chord':
      case 'structure':
        this.#build();
        break;
      case 'root':
      case 'decay':
      case 'damping':
      case 'brightness':
        this.#tune(time);
        break;
      case 'spread':
        for (const { pan, sign } of this.sides) pan.pan.setTargetAtTime(sign * value, time, SMOOTH);
        break;
      case 'level': this.level.gain.setTargetAtTime(dbToGain(value) / CLIP_RANGE, time, SMOOTH); break;
      case 'mix':
        this.dry.gain.setTargetAtTime(1 - value, time, SMOOTH);
        this.wet.gain.setTargetAtTime(value, time, SMOOTH);
        break;
    }
  }

  dispose() {
    this.idle.stop();
    super.dispose();
  }
}

const dbToGain = (db) => 10 ** (db / 20);

/** Set a param now (`time` undefined), or glide it there from `time`. */
function set(param, value, time) {
  if (time == null) param.value = value;
  else param.setTargetAtTime(value, time, SMOOTH);
}
