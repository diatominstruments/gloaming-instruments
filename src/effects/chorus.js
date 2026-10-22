import { Effect, num, choice } from '../module.js';
import { SMOOTH } from '../util.js';

/**
 * The three settings of the classic bucket-brigade polysynth chorus: I and
 * II are slow and deep, I+II is a fast, shallow shimmer. PolySynth's
 * `chorus` switch picks from these, and they're the Chorus presets too.
 */
export const CHORUS_MODES = Object.freeze({
  'I': { rate: 0.513, depth: 0.00185, delay: 0.0035 },
  'II': { rate: 0.863, depth: 0.00185, delay: 0.0035 },
  'I+II': { rate: 9.75, depth: 0.0002, delay: 0.0035 },
});

/** Ensemble: the fast LFO runs this many times quicker than `rate`, at this share of `depth`. */
const FAST_RATIO = 10;
const FAST_DEPTH = 0.15;
/** Ensemble lines' outputs, [channel, gain]: left, centre (both sides, equal-power), right. */
const ENSEMBLE_OUTS = [[[0, 1]], [[0, Math.SQRT1_2], [1, Math.SQRT1_2]], [[1, 1]]];
/** Each side of the ensemble carries a line and a half's power; this brings it back to one. */
const ENSEMBLE_LEVEL = Math.sqrt(2 / 3);

/** A unit sine starting `phase` radians into its cycle. */
function sineAt(ctx, phase) {
  return new PeriodicWave(ctx, { real: [0, Math.sin(phase)], imag: [0, Math.cos(phase)], disableNormalization: true });
}

/**
 * Chorus — short delay lines swept by LFOs, mixed back with the dry signal.
 * The input is summed to mono on the way into the lines; the dry signal
 * passes through untouched.
 *
 * As a chorus, two lines are swept by one triangle LFO in opposite
 * directions, the left line on the LFO and the right on its inverse, so
 * while one side's pitch bends up the other bends down. That opposition is
 * where the width comes from.
 *
 * As an ensemble, in the manner of the string machines' ensemble circuit,
 * three lines are each swept by two sine LFOs at once, a slow one at
 * `rate` and a fast one ten times quicker and shallower, every line a
 * third of a cycle behind the last on both. Panned left, centre and right,
 * they never all bend the same way at once, which gives the thick, shimmering
 * string-section blur rather than a chorus's swing.
 *
 * The wet path is lowpassed at `tone`, like the dark, slightly lo-fi
 * output of a bucket-brigade delay chip.
 */
export class Chorus extends Effect {
  static id = 'chorus';
  static label = 'Chorus';
  static description = 'Stereo chorus, or a three-line string ensemble. Widens and thickens pads, keys and strings.';
  static tags = ['modulation', 'space'];
  static params = {
    type: choice(['chorus', 'ensemble'], 'chorus', {
      label: 'Type',
      description: 'Chorus sweeps two lines in opposite directions; Ensemble sweeps three with a slow and a fast LFO, for strings.',
      labels: { chorus: 'Chorus', ensemble: 'Ensemble' },
    }),
    rate: num(0.05, 12, CHORUS_MODES.I.rate, {
      unit: 'Hz', scale: 'log', primary: true, label: 'Rate', description: 'Speed of the sweep (the slow one, in Ensemble).',
    }),
    depth: num(0, 0.005, CHORUS_MODES.I.depth, {
      unit: 's', primary: true, label: 'Depth', description: 'How far each delay line swings either side of its centre.',
    }),
    delay: num(0.001, 0.02, CHORUS_MODES.I.delay, {
      unit: 's', scale: 'log', label: 'Delay', description: 'Centre of the sweep; longer drifts toward doubling.',
    }),
    tone: num(1000, 16000, 9000, {
      unit: 'Hz', scale: 'log', label: 'Tone', description: 'Lowpass on the chorused signal.',
    }),
    mix: num(0, 1, 0.5, {
      unit: '%', primary: true, label: 'Mix', description: 'Chorused against the dry signal.',
    }),
  };
  static groups = [
    { id: 'sweep', label: 'Sweep', params: ['type', 'rate', 'depth', 'delay'] },
    { id: 'output', label: 'Output', params: ['tone', 'mix'] },
  ];
  static presets = {
    'Mode I': { ...CHORUS_MODES.I },
    'Mode II': { ...CHORUS_MODES.II },
    'Mode I+II': { ...CHORUS_MODES['I+II'] },
    'Slow and wide': { rate: 0.2, depth: 0.004, delay: 0.008, tone: 7000, mix: 0.5 },
    'Ensemble': { type: 'ensemble', rate: 0.6, depth: 0.0015, delay: 0.006, tone: 8000, mix: 0.6 },
    'Lush ensemble': { type: 'ensemble', rate: 0.35, depth: 0.0025, delay: 0.008, tone: 7000, mix: 0.65 },
  };

  constructor(ctx, params) {
    super(ctx, params);
    const p = this.params;
    this.dry = new GainNode(ctx, { gain: 1 - p.mix });
    this.wet = new GainNode(ctx, { gain: p.mix });
    this.input.connect(this.dry).connect(this.output);

    const mono = new GainNode(ctx, { channelCount: 1, channelCountMode: 'explicit', channelInterpretation: 'speakers' });
    this.tone = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: p.tone, Q: -3 });
    this.merger = new ChannelMergerNode(ctx, { numberOfInputs: 2 });
    this.input.connect(mono).connect(this.tone);
    this.merger.connect(this.wet).connect(this.output);
    this.#build();
  }

  /**
   * The lines and LFOs for the current type, replacing any already built.
   * `lfos` holds each oscillator with its multiple of `rate`; each line's
   * `swings` hold a gain with its multiple of `depth`.
   */
  #build() {
    const ctx = this.ctx;
    const p = this.params;
    if (this.lfos) {
      for (const { osc } of this.lfos) osc.stop();
      this.tone.disconnect();
      for (const line of this.lines) line.delay.disconnect();
    }
    if (p.type === 'ensemble') {
      const phases = [0, 1, 2].map((k) => (2 * Math.PI * k) / 3);
      const slow = phases.map((phase) => new OscillatorNode(ctx, { periodicWave: sineAt(ctx, phase), frequency: p.rate }));
      const fast = phases.map((phase) => new OscillatorNode(ctx, { periodicWave: sineAt(ctx, phase), frequency: p.rate * FAST_RATIO }));
      this.lfos = [...slow.map((osc) => ({ osc, ratio: 1 })), ...fast.map((osc) => ({ osc, ratio: FAST_RATIO }))];
      this.lines = phases.map((_, k) => this.#line([[slow[k], 1], [fast[k], FAST_DEPTH]], ENSEMBLE_OUTS[k], ENSEMBLE_LEVEL));
    } else {
      // One swing per side, the right's negated, so they always oppose.
      const lfo = new OscillatorNode(ctx, { type: 'triangle', frequency: p.rate });
      this.lfos = [{ osc: lfo, ratio: 1 }];
      this.lines = [1, -1].map((sign, side) => this.#line([[lfo, sign]], [[side, 1]]));
    }
    const t = ctx.currentTime;
    for (const { osc } of this.lfos) osc.start(t);
  }

  /** A delay line off the tone filter, swept by `mods` ([lfo, share of depth]) and sent to `outs`. */
  #line(mods, outs, level = 1) {
    const { delay: centre, depth } = this.params;
    const delay = new DelayNode(this.ctx, { maxDelayTime: 0.05, delayTime: centre });
    const swings = mods.map(([lfo, scale]) => {
      const gain = new GainNode(this.ctx, { gain: scale * depth });
      lfo.connect(gain).connect(delay.delayTime);
      return { gain, scale };
    });
    this.tone.connect(delay);
    for (const [channel, gain] of outs) delay.connect(new GainNode(this.ctx, { gain: gain * level })).connect(this.merger, 0, channel);
    return { delay, swings };
  }

  applyParam(name, value, time) {
    switch (name) {
      case 'type': this.#build(); break;
      case 'rate':
        for (const { osc, ratio } of this.lfos) osc.frequency.setTargetAtTime(value * ratio, time, SMOOTH);
        break;
      case 'depth':
        for (const line of this.lines) for (const { gain, scale } of line.swings) gain.gain.setTargetAtTime(scale * value, time, SMOOTH);
        break;
      case 'delay':
        for (const line of this.lines) line.delay.delayTime.setTargetAtTime(value, time, 0.05);
        break;
      case 'tone': this.tone.frequency.setTargetAtTime(value, time, SMOOTH); break;
      case 'mix':
        this.dry.gain.setTargetAtTime(1 - value, time, SMOOTH);
        this.wet.gain.setTargetAtTime(value, time, SMOOTH);
        break;
    }
  }

  dispose() {
    for (const { osc } of this.lfos) osc.stop();
    super.dispose();
  }
}
