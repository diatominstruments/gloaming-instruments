import { Effect, num } from '../module.js';
import { SMOOTH } from '../util.js';

/**
 * Compressor — turns down whatever rises past `threshold`, by `ratio`,
 * easing in over the `knee` dB above it; `makeup` brings the level back
 * up afterwards. Built on DynamicsCompressorNode, so it renders offline
 * like everything else.
 *
 * Web Audio's compressor also adds makeup gain of its own, so raising the
 * ratio would make things louder. That's cancelled here: `makeup` is the
 * only gain, and threshold and ratio mean what they say.
 *
 * No dry/wet mix: the node looks a few milliseconds ahead, which delays
 * its output, so blending it with the dry signal would comb-filter. For
 * parallel compression, split the signal before it instead.
 */
export class Compressor extends Effect {
  static id = 'compressor';
  static label = 'Compressor';
  static description = 'Evens out levels by turning down whatever rises past the threshold.';
  static tags = ['dynamics'];
  static params = {
    threshold: num(-60, 0, -24, {
      unit: 'dB', primary: true, label: 'Threshold', description: 'Level above which the signal is turned down.',
    }),
    ratio: num(1, 20, 4, {
      unit: ':1', scale: 'log', primary: true,
      label: 'Ratio', description: 'How hard: at 4:1, 4 dB over the threshold comes out as 1 dB over.',
    }),
    knee: num(0, 40, 6, {
      unit: 'dB', label: 'Knee', description: 'How many dB above the threshold compression takes to reach full ratio.',
    }),
    attack: num(0.001, 1, 0.01, {
      unit: 's', scale: 'log', label: 'Attack', description: 'How quickly it clamps down; slower lets transients through.',
    }),
    release: num(0.01, 1, 0.25, {
      unit: 's', scale: 'log', label: 'Release', description: 'How quickly it lets go once the level drops.',
    }),
    makeup: num(0, 24, 0, {
      unit: 'dB', primary: true, label: 'Makeup', description: 'Gain after compression, to restore the level.',
    }),
  };
  static groups = [
    {
      id: 'curve', label: 'Curve', params: ['threshold', 'ratio', 'knee'],
      role: 'dynamics', bind: { threshold: 'threshold', ratio: 'ratio', knee: 'knee' },
    },
    { id: 'timing', label: 'Timing', params: ['attack', 'release'] },
    { id: 'output', label: 'Output', params: ['makeup'] },
  ];
  static presets = {
    'Glue': { threshold: -18, ratio: 2, knee: 10, attack: 0.03, release: 0.3, makeup: 3 },
    'Punch': { threshold: -24, ratio: 4, knee: 6, attack: 0.02, release: 0.15, makeup: 9 },
    'Squash': { threshold: -30, ratio: 10, knee: 2, attack: 0.002, release: 0.1, makeup: 18 },
    'Limiter': { threshold: -6, ratio: 20, knee: 0, attack: 0.001, release: 0.1, makeup: 4 },
  };

  constructor(ctx, params) {
    super(ctx, params);
    const p = this.params;
    this.comp = new DynamicsCompressorNode(ctx, {
      threshold: p.threshold, ratio: p.ratio, knee: p.knee, attack: p.attack, release: p.release,
    });
    this.makeup = new GainNode(ctx, { gain: this.#makeupGain() });
    this.input.connect(this.comp).connect(this.makeup).connect(this.output);
  }

  /** Current gain reduction in dB (≤ 0), for a meter. */
  get reduction() {
    return this.comp.reduction;
  }

  applyParam(name, value, time) {
    if (name !== 'makeup') this.comp[name].setTargetAtTime(value, time, SMOOTH);
    // The built-in makeup follows threshold, ratio and knee, so every change
    // but attack and release moves the compensation too.
    if (name !== 'attack' && name !== 'release') this.makeup.gain.setTargetAtTime(this.#makeupGain(), time, SMOOTH);
  }

  #makeupGain() {
    const { threshold, ratio, knee, makeup } = this.params;
    return dbToGain(makeup - builtInMakeupDb(threshold, ratio, knee));
  }
}

const dbToGain = (db) => 10 ** (db / 20);
const gainToDb = (gain) => 20 * Math.log10(gain);

/**
 * The makeup gain Web Audio's compressor applies by itself, in dB: 60% of
 * what a full-scale signal loses on the node's static curve. The curve is
 * the spec's: unity up to the threshold, then an exponential knee (in
 * linear amplitude) whose slope eases down to exactly 1/ratio at
 * threshold + knee, then a straight line at that slope. The knee's
 * sharpness `k` has no closed form, so it's found by bisection, as the
 * browsers do.
 */
function builtInMakeupDb(threshold, ratio, knee) {
  const t = dbToGain(threshold);
  const kneeEnd = dbToGain(threshold + knee);
  const curve = (x, k) => (x < t ? x : t + (1 - Math.exp(-k * (x - t))) / k);
  const slopeDb = (x, k) => {
    const x2 = x * 1.001;
    return (gainToDb(curve(x2, k)) - gainToDb(curve(x, k))) / (gainToDb(x2) - gainToDb(x));
  };
  let lo = Math.log(0.1);
  let hi = Math.log(10000);
  for (let i = 0; i < 15; i++) {
    const mid = (lo + hi) / 2;
    if (slopeDb(kneeEnd, Math.exp(mid)) > 1 / ratio) lo = mid;
    else hi = mid;
  }
  const k = Math.exp((lo + hi) / 2);
  const fullScaleDb = threshold + knee >= 0
    ? gainToDb(curve(1, k))
    : gainToDb(curve(kneeEnd, k)) - (threshold + knee) / ratio;
  return -0.6 * fullScaleDb;
}
