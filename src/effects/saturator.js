import { Effect, num, choice } from '../module.js';
import { SMOOTH } from '../util.js';

// Same scheme as Drive: the curve spans inputs of ±1 and is shape(x × HEADROOM),
// and the signal is scaled down by HEADROOM on the way in, so the net
// transfer is shape(signal × drive) for anything the curve covers.
const HEADROOM = 8;
// Web Audio takes lowpass and highpass Q in dB; this is Butterworth (1/√2).
const BUTTERWORTH = 20 * Math.log10(Math.SQRT1_2);
const EMPHASIS_HZ = 700;
// Bias moves the DC level into the curve, and the blocker lets a fast move
// through as a thump; ramping it over ~0.3 s keeps that below hearing.
const BIAS_SMOOTH = 0.1;

/** The transfer curves, each taking the driven signal to roughly ±1. */
const SHAPES = {
  // Cubic soft clip: dead straight at low levels, and fully rounded into ±1
  // by 1.5, so it only touches the peaks. The gentlest of the set.
  soft: (u) => (Math.abs(u) < 1.5 ? u - (4 / 27) * u ** 3 : Math.sign(u)),
  // Tanh, but the negative half gives out at two thirds of the level: the
  // lopsidedness adds even harmonics, the warm, thick ones.
  tube: (u) => (u >= 0 ? Math.tanh(u) : Math.tanh(1.5 * u) / 1.5),
  // Straight up to 0.9, then a very short knee into a hard wall. Bright and forward.
  clip: (u) => {
    const a = Math.abs(u);
    return Math.sign(u) * (a < 0.9 ? a : 0.9 + 0.1 * Math.tanh((a - 0.9) / 0.1));
  },
  // A sine, so peaks past the top fold back down instead of flattening.
  // The input is soft-limited to 2.5 quarter-turns first, so extreme drive
  // settles into a fixed number of folds rather than turning to hash.
  fold: (u) => Math.sin((Math.PI / 2) * 5 * Math.tanh(u / 5)),
  // Full-wave rectified tanh: the negative half flips up, which doubles the
  // frequency, the octave-up of an octave fuzz. The DC this leaves is blocked
  // after; blend it in with `mix` to keep the fundamental.
  octave: (u) => Math.abs(Math.tanh(u)),
};

function shapeCurve(shape) {
  const f = SHAPES[shape];
  const curve = new Float32Array(8192);
  for (let i = 0; i < curve.length; i++) {
    curve[i] = f(((i / (curve.length - 1)) * 2 - 1) * HEADROOM);
  }
  return curve;
}

/**
 * Saturator — a harmonic colour box for buses and the mix, going past the
 * plain tanh of Drive and Tape:
 *
 *   shape      the transfer curve, from barely-there to wavefolding and
 *              octave-up rectification
 *   bias       offsets the signal into the curve, so it saturates
 *              lopsidedly and adds even harmonics at any drive, even on
 *              quiet material; the offset itself is blocked after
 *   color      pre- and de-emphasis: tilt the spectrum before the curve and
 *              tilt it back after, so the frequencies tilted up distort
 *              more while the clean tonal balance comes out unchanged.
 *              Below zero drives the lows harder, above the highs
 *   band       saturate only below or above `crossover` and leave the rest
 *              clean: highs only is an exciter, lows only thickens bass
 *              so it reads on small speakers
 *   mix        parallel blend with the clean signal
 *
 * Half the drive (in dB) is taken back after the curve, as in Tape.
 *
 * The shaper runs without oversampling, so the wet signal stays exactly in
 * time with the clean one and `mix` and `band` blend without comb
 * filtering. The price is some aliasing at high drive, most audible on
 * the hard shapes with lots of top end going in.
 */
export class Saturator extends Effect {
  static id = 'saturator';
  static label = 'Saturator';
  static description = 'Harmonic colour: five curves, bias for even harmonics, emphasis, and a band split for exciter or bass duty.';
  static tags = ['distortion', 'character'];
  static params = {
    drive: num(0, 36, 6, {
      unit: 'dB', primary: true, label: 'Drive', description: 'How hard the signal is pushed into the curve.',
    }),
    shape: choice(Object.keys(SHAPES), 'tube', {
      primary: true, label: 'Shape', description: 'The saturation curve, which sets the flavour of the harmonics.',
      labels: { soft: 'Soft', tube: 'Tube', clip: 'Hard clip', fold: 'Wavefold', octave: 'Octave' },
    }),
    bias: num(0, 1, 0, {
      unit: '%', label: 'Bias', description: 'Offsets the signal into the curve for lopsided, even-harmonic saturation.',
    }),
    color: num(-12, 12, 0, {
      unit: 'dB', center: 0, label: 'Colour',
      description: 'Which end distorts more: below zero the lows are driven harder, above zero the highs. The clean balance is unchanged.',
    }),
    band: choice(['full', 'lows', 'highs'], 'full', {
      label: 'Band', description: 'Saturate everything, or only one side of the crossover and leave the other clean.',
      labels: { full: 'Full range', lows: 'Lows only', highs: 'Highs only' },
    }),
    crossover: num(60, 8000, 200, {
      unit: 'Hz', scale: 'log', label: 'Crossover', description: 'Where the saturated band meets the clean one.',
      activeWhen: { band: ['lows', 'highs'] },
    }),
    mix: num(0, 1, 1, {
      unit: '%', primary: true, label: 'Mix', description: 'Blend of saturated and clean signal.',
    }),
    output: num(-12, 12, 0, {
      unit: 'dB', center: 0, label: 'Output', description: 'Level after everything else.',
    }),
  };
  static groups = [
    { id: 'drive', label: 'Drive', params: ['drive', 'shape', 'bias'] },
    { id: 'focus', label: 'Focus', params: ['color', 'band', 'crossover'] },
    { id: 'output', label: 'Output', params: ['mix', 'output'] },
  ];
  static presets = {
    'Warmth': { drive: 6, shape: 'tube', bias: 0.3, color: -3 },
    'Glue': { drive: 4, shape: 'soft' },
    'Exciter': { drive: 18, shape: 'clip', band: 'highs', crossover: 4000, mix: 0.3 },
    'Bass harmonics': { drive: 15, shape: 'tube', bias: 0.4, band: 'lows', crossover: 150, mix: 0.6 },
    'Octave up': { drive: 12, shape: 'octave', band: 'lows', crossover: 250, mix: 0.3, output: -2 },
    'Folded': { drive: 14, shape: 'fold', color: 4, mix: 0.5, output: -3 },
    'Crunch': { drive: 20, shape: 'clip', color: 6, output: -4 },
  };

  constructor(ctx, params) {
    super(ctx, params);
    const p = this.params;

    // Linkwitz-Riley crossover (two Butterworths each side), whose halves
    // sum back to flat. `#route` wires each half to the saturator or past it.
    const crossover = (type) => {
      const a = new BiquadFilterNode(ctx, { type, frequency: p.crossover, Q: BUTTERWORTH });
      const b = new BiquadFilterNode(ctx, { type, frequency: p.crossover, Q: BUTTERWORTH });
      a.connect(b);
      return [a, b];
    };
    this.lows = crossover('lowpass');
    this.highs = crossover('highpass');
    this.saturate = new GainNode(ctx);
    this.clean = new GainNode(ctx);
    this.sum = new GainNode(ctx);

    this.dry = new GainNode(ctx, { gain: 1 - p.mix });
    this.emphasis = new BiquadFilterNode(ctx, { type: 'highshelf', frequency: EMPHASIS_HZ, gain: p.color });
    this.pre = new GainNode(ctx, { gain: preGain(p.drive, p.color) });
    this.shaper = new WaveShaperNode(ctx, { curve: shapeCurve(p.shape) });
    this.bias = new ConstantSourceNode(ctx, { offset: p.bias / HEADROOM });
    this.post = new GainNode(ctx, { gain: postGain(p.drive, p.color) });
    this.deemphasis = new BiquadFilterNode(ctx, { type: 'highshelf', frequency: EMPHASIS_HZ, gain: -p.color });
    this.wet = new GainNode(ctx, { gain: p.mix });
    this.dcBlock = new BiquadFilterNode(ctx, { type: 'highpass', frequency: 10, Q: BUTTERWORTH });
    this.trim = new GainNode(ctx, { gain: dbToGain(p.output) });

    this.saturate.connect(this.dry).connect(this.sum);
    this.saturate.connect(this.emphasis).connect(this.pre).connect(this.shaper).connect(this.post)
      .connect(this.deemphasis).connect(this.wet).connect(this.sum);
    this.bias.connect(this.shaper);
    this.clean.connect(this.sum);
    this.sum.connect(this.dcBlock).connect(this.trim).connect(this.output);
    this.bias.start();
    this.#route();
  }

  #route() {
    const lows = this.lows.at(-1);
    const highs = this.highs.at(-1);
    this.input.disconnect();
    lows.disconnect();
    highs.disconnect();
    const { band } = this.params;
    // Full range skips the crossover, so the mix isn't phase-shifted around it for nothing.
    if (band === 'full') {
      this.input.connect(this.saturate);
      return;
    }
    this.input.connect(this.lows[0]);
    this.input.connect(this.highs[0]);
    lows.connect(band === 'lows' ? this.saturate : this.clean);
    highs.connect(band === 'highs' ? this.saturate : this.clean);
  }

  applyParam(name, value, time) {
    const set = (param, v, tc = SMOOTH) => param.setTargetAtTime(v, time, tc);
    const { drive, color } = this.params;
    switch (name) {
      case 'color':
        set(this.emphasis.gain, value);
        set(this.deemphasis.gain, -value);
        // falls through: the tilt's level half lives in the gains
      case 'drive':
        set(this.pre.gain, preGain(drive, color));
        set(this.post.gain, postGain(drive, color));
        break;
      case 'shape': this.shaper.curve = shapeCurve(value); break;
      case 'bias': set(this.bias.offset, value / HEADROOM, BIAS_SMOOTH); break;
      case 'band': this.#route(); break;
      case 'crossover':
        for (const filter of [...this.lows, ...this.highs]) set(filter.frequency, value);
        break;
      case 'mix':
        set(this.dry.gain, 1 - value);
        set(this.wet.gain, value);
        break;
      case 'output': set(this.trim.gain, dbToGain(value)); break;
    }
  }

  dispose() {
    this.bias.stop();
    super.dispose();
  }
}

const dbToGain = (db) => 10 ** (db / 20);
// The emphasis shelf raises the highs by `color`; taking half of that off
// the gain before the curve makes it a tilt (lows -color/2, highs
// +color/2), and the post gain and de-emphasis shelf undo both.
const preGain = (drive, color) => dbToGain(drive - color / 2) / HEADROOM;
const postGain = (drive, color) => dbToGain(-drive / 2 + color / 2);
