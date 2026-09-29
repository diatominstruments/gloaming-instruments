import { Effect, num } from '../module.js';
import { SMOOTH } from '../util.js';
import { builtInMakeupDb } from './compressor.js';

// The compressor sits this far under the ceiling, so at its 20:1 a peak
// 20 dB over comes out 1 dB under, just reaching the clipper's knee.
const THRESHOLD_BELOW = 2;
// The clipper passes everything below this (as a fraction of the ceiling,
// here -1 dB) untouched, and rounds what's above it off into the ceiling.
const KNEE = 10 ** (-1 / 20);
// The clipper's curve spans ±CLIP_RANGE × the ceiling (+12 dB); anything
// hotter lands on its flat ends, which sit exactly at the ceiling.
const CLIP_RANGE = 4;

function clipCurve() {
  const curve = new Float32Array(8192);
  for (let i = 0; i < curve.length; i++) {
    const u = ((i / (curve.length - 1)) * 2 - 1) * CLIP_RANGE;
    const a = Math.abs(u);
    curve[i] = Math.sign(u) * (a <= KNEE ? a : KNEE + (1 - KNEE) * Math.tanh((a - KNEE) / (1 - KNEE)));
  }
  return curve;
}

/**
 * Limiter — keeps the mix under `ceiling` however hard `input` pushes it,
 * for the end of a master chain. Two stages: a DynamicsCompressorNode at
 * 20:1 with no knee and the fastest attack does the audible work, riding
 * the level down smoothly; then a soft clipper at the ceiling catches the
 * few milliseconds of overshoot the compressor's attack lets through, so
 * nothing ever passes the ceiling.
 *
 * The clipper isn't oversampled: resampling filters ring past whatever
 * they're given, which put peaks back over the ceiling. It works so rarely
 * and so gently that its aliasing stays buried.
 *
 * The compressor's built-in makeup gain is cancelled, as in Compressor, so
 * `input` is the only gain and louder means pushing harder into the limit.
 */
export class Limiter extends Effect {
  static id = 'limiter';
  static label = 'Limiter';
  static description = 'Keeps the mix under a ceiling however hard it is pushed. Goes last on the master.';
  static tags = ['dynamics'];
  static params = {
    input: num(0, 24, 0, {
      unit: 'dB', primary: true, label: 'Input', description: 'Gain into the limiter: turn it up for loudness.',
    }),
    ceiling: num(-12, 0, -1, {
      unit: 'dB', primary: true, label: 'Ceiling', description: 'The level nothing gets past.',
    }),
    release: num(0.01, 1, 0.1, {
      unit: 's', scale: 'log', primary: true,
      label: 'Release', description: 'How quickly it lets go: short is louder but can pump or distort the bass.',
    }),
  };
  static groups = [
    { id: 'limit', label: 'Limit', params: ['input', 'ceiling', 'release'] },
  ];
  static presets = {
    'Safety': { input: 0, ceiling: -1, release: 0.1 },
    'Loud': { input: 6, ceiling: -0.5, release: 0.08 },
    'Slammed': { input: 14, ceiling: -0.3, release: 0.03 },
    'Smooth': { input: 4, ceiling: -1, release: 0.4 },
  };

  constructor(ctx, params) {
    super(ctx, params);
    const p = this.params;
    this.pre = new GainNode(ctx, { gain: dbToGain(p.input) });
    this.comp = new DynamicsCompressorNode(ctx, {
      threshold: p.ceiling - THRESHOLD_BELOW, ratio: 20, knee: 0, attack: 0, release: p.release,
    });
    this.toClip = new GainNode(ctx, { gain: this.#toClipGain() });
    this.clipper = new WaveShaperNode(ctx, { curve: clipCurve() });
    this.fromClip = new GainNode(ctx, { gain: dbToGain(p.ceiling) });
    this.input.connect(this.pre).connect(this.comp).connect(this.toClip)
      .connect(this.clipper).connect(this.fromClip).connect(this.output);
  }

  /** The compressor's current gain reduction in dB (≤ 0), for a meter. Excludes the clipper. */
  get reduction() {
    return this.comp.reduction;
  }

  applyParam(name, value, time) {
    switch (name) {
      case 'input': this.pre.gain.setTargetAtTime(dbToGain(value), time, SMOOTH); break;
      case 'release': this.comp.release.setTargetAtTime(value, time, SMOOTH); break;
      case 'ceiling':
        this.comp.threshold.setTargetAtTime(value - THRESHOLD_BELOW, time, SMOOTH);
        this.toClip.gain.setTargetAtTime(this.#toClipGain(), time, SMOOTH);
        this.fromClip.gain.setTargetAtTime(dbToGain(value), time, SMOOTH);
        break;
    }
  }

  // Cancels the compressor's built-in makeup, and scales the ceiling to 1 / CLIP_RANGE
  // on the clipper's curve; `fromClip` scales it back.
  #toClipGain() {
    const threshold = this.params.ceiling - THRESHOLD_BELOW;
    return dbToGain(-builtInMakeupDb(threshold, 20, 0) - this.params.ceiling) / CLIP_RANGE;
  }
}

const dbToGain = (db) => 10 ** (db / 20);
