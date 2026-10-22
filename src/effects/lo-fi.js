import { Effect, num } from '../module.js';
import { rng, SMOOTH } from '../util.js';

// ---- bit depth ---------------------------------------------------------------
//
// One fixed staircase does every bit depth. It quantizes its input to steps
// of 1/STEPS; scaling the signal up by g on the way in and down by 1/g on
// the way out makes that a step of 1/(g·STEPS) on the signal itself. So
// `bits` is just g = 2^(bits−1) / STEPS, and can be swept like any gain.
//
// g and 1/g come from one control signal through two lookup curves, so at
// every sample they cancel exactly, however fast `bits` moves; two gains
// gliding separately would overshoot in between.

const MIN_BITS = 1;
const MAX_BITS = 12;
/** Signal level the staircase covers (±) at the most bits; beyond it, digital clipping. */
const HEADROOM = 2;
/** Staircase steps per unit of the curve's input, enough for MAX_BITS within HEADROOM. */
const STEPS = 2 ** (MAX_BITS - 1) * HEADROOM;
/** Curve points per step: the shaper interpolates between points, which slopes each step's edge by 1/this. */
const POINTS_PER_STEP = 16;
/** Points in the lookup curves from `bits` to each gain. */
const GAIN_POINTS = 4097;

let staircase = null;
let gainCurves = null;

/**
 * round(u · STEPS) / STEPS across the shaper's −1..1, rounding halves away
 * from zero so the two sides mirror (Math.round takes −0.5 up to 0).
 */
function stairCurve() {
  if (!staircase) {
    const n = 2 * STEPS * POINTS_PER_STEP + 1;
    staircase = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const u = ((i / (n - 1)) * 2 - 1) * STEPS;
      staircase[i] = (Math.sign(u) * Math.round(Math.abs(u))) / STEPS;
    }
  }
  return staircase;
}

/** `bits` spread over a shaper's −1..1, and back. */
const bitsToSignal = (bits) => ((bits - MIN_BITS) / (MAX_BITS - MIN_BITS)) * 2 - 1;
const inputGain = (bits) => 2 ** (bits - 1) / STEPS;

/** Curves from the bits signal to g and to 1/g. */
function bitCurves() {
  if (!gainCurves) {
    const pre = new Float32Array(GAIN_POINTS);
    const post = new Float32Array(GAIN_POINTS);
    for (let i = 0; i < GAIN_POINTS; i++) {
      const g = inputGain(MIN_BITS + ((MAX_BITS - MIN_BITS) * i) / (GAIN_POINTS - 1));
      pre[i] = g;
      post[i] = 1 / g;
    }
    gainCurves = { pre, post };
  }
  return gainCurves;
}

// ---- crackle -----------------------------------------------------------------

const CRACKLE_SECONDS = 6;
/** Clicks per second, on average. */
const CRACKLE_DENSITY = 18;
/** Steady surface noise under the clicks. */
const SURFACE = 0.004;
const crackles = new WeakMap();

/**
 * A seeded loop of record-surface noise: sparse clicks at random times,
 * mostly faint with the odd loud pop, each a sharp edge decaying into a few
 * samples of grit, over a bed of quiet noise. Built once per context.
 */
function crackleBuffer(ctx) {
  let buffer = crackles.get(ctx);
  if (!buffer) {
    const fs = ctx.sampleRate;
    const length = Math.round(CRACKLE_SECONDS * fs);
    buffer = ctx.createBuffer(1, length, fs);
    const data = buffer.getChannelData(0);
    const random = rng(0xc4ac);
    for (let i = 0; i < length; i++) data[i] = (random() * 2 - 1) * SURFACE;
    let at = 0;
    for (;;) {
      at += Math.ceil((-Math.log(1 - random()) * fs) / CRACKLE_DENSITY);
      if (at >= length) break;
      const amp = random() ** 4 * (random() < 0.5 ? -1 : 1);
      const span = 4 + Math.floor(random() * 24);
      for (let k = 0; k < span * 4 && at + k < length; k++) {
        data[at + k] += amp * Math.exp(-k / span) * (k ? random() * 2 - 1 : 1);
      }
    }
    crackles.set(ctx, buffer);
  }
  return buffer;
}

/** Tops of `rate` and `tone`, where each switches off. */
const RATE_OFF = 16000;
const TONE_OPEN = 20000;

/**
 * LoFi — old samplers and worn records: fewer bits, a lower sample rate's
 * mirror tones, a narrower bandwidth, and crackle.
 *
 *   bits     quantizes the signal to 2^bits levels across ±1, sweepable
 *            (see above); quiet sounds grow grainy and the quietest fall
 *            to silence, as on a 12- or 8-bit sampler
 *   rate     imitates a lower sample rate. Web Audio has no way to hold a
 *            sample, so instead the signal is gated by a square wave at
 *            `rate`, which mirrors its spectrum around every multiple of
 *            it: the inharmonic, metallic fold-over that is what a low
 *            sample rate sounds like. Off at the top of its range
 *   tone     lowpass after everything, the narrow bandwidth of old gear
 *   crackle  seeded record-surface noise, mixed in before the crushing so
 *            it's degraded along with the sound
 *
 * The shaper isn't oversampled, so everything stays exactly in time with
 * the dry signal for `mix`, and the aliasing it adds is part of the sound.
 */
export class LoFi extends Effect {
  static id = 'lo-fi';
  static label = 'Lo-fi';
  static description = 'Bit crushing, sample-rate fold-over, narrow bandwidth and vinyl crackle. Old samplers and worn records.';
  static tags = ['distortion', 'character'];
  static params = {
    bits: num(MIN_BITS, MAX_BITS, 8, {
      primary: true, label: 'Bits', description: 'Bit depth: fewer bits are grainier, and quiet sounds break up first.',
      marks: [{ value: 12, label: '12' }, { value: 8, label: '8' }, { value: 4, label: '4' }],
    }),
    rate: num(500, RATE_OFF, 11025, {
      unit: 'Hz', scale: 'log', primary: true, marks: [{ value: RATE_OFF, label: 'Off' }],
      label: 'Rate', description: 'Imitated sample rate: lower folds more metallic mirror tones into the sound. Off at the top.',
    }),
    tone: num(500, TONE_OPEN, 7000, {
      unit: 'Hz', scale: 'log', label: 'Tone', description: 'Lowpass on the result, for the narrow bandwidth of old gear; all the way up is off.',
    }),
    crackle: num(0, 1, 0, {
      unit: '%', label: 'Crackle', description: 'Record-surface clicks and pops.',
    }),
    mix: num(0, 1, 1, {
      unit: '%', primary: true, label: 'Mix', description: 'Degraded against the clean signal.',
    }),
  };
  static groups = [
    { id: 'digital', label: 'Digital', params: ['bits', 'rate'] },
    { id: 'analog', label: 'Analog', params: ['tone', 'crackle'] },
    { id: 'output', label: 'Output', params: ['mix'] },
  ];
  static presets = {
    '12-bit sampler': { bits: 12, rate: 13000, tone: 10000, crackle: 0, mix: 1 },
    '8-bit': { bits: 8, rate: 8000, tone: 6000, crackle: 0, mix: 1 },
    'Crushed': { bits: 4, rate: 4000, tone: 5000, crackle: 0, mix: 1 },
    'Dusty vinyl': { bits: 12, rate: RATE_OFF, tone: 6500, crackle: 0.5, mix: 1 },
    'Radio': { bits: 10, rate: RATE_OFF, tone: 3000, crackle: 0.2, mix: 1 },
    'Parallel grit': { bits: 5, rate: 6000, tone: 9000, crackle: 0, mix: 0.35 },
  };

  constructor(ctx, params) {
    super(ctx, params);
    const p = this.params;
    this.dry = new GainNode(ctx, { gain: 1 - p.mix });
    this.wet = new GainNode(ctx, { gain: p.mix });
    this.input.connect(this.dry).connect(this.output);

    // Crackle joins the input on its way into the crusher.
    const into = new GainNode(ctx);
    this.input.connect(into);
    this.crackleSource = new AudioBufferSourceNode(ctx, { buffer: crackleBuffer(ctx), loop: true });
    this.crackle = new GainNode(ctx, { gain: crackleGain(p.crackle) });
    this.crackleSource
      .connect(new BiquadFilterNode(ctx, { type: 'highpass', frequency: 300, Q: -3 }))
      .connect(this.crackle)
      .connect(into);

    // Bits: g in, the staircase, 1/g out, both gains set by the one signal.
    const { pre, post } = bitCurves();
    this.bits = new ConstantSourceNode(ctx, { offset: bitsToSignal(p.bits) });
    this.pre = new GainNode(ctx, { gain: 0 });
    this.post = new GainNode(ctx, { gain: 0 });
    this.bits.connect(new WaveShaperNode(ctx, { curve: pre })).connect(this.pre.gain);
    this.bits.connect(new WaveShaperNode(ctx, { curve: post })).connect(this.post.gain);
    const stairs = new WaveShaperNode(ctx, { curve: stairCurve() });

    // Rate: a gate of 1 + square, so 0 or 2, averaging 1. Depth 0 is off.
    this.clock = new OscillatorNode(ctx, { type: 'square', frequency: p.rate });
    this.clockDepth = new GainNode(ctx, { gain: rateDepth(p.rate) });
    this.gate = new GainNode(ctx, { gain: 1 });
    this.clock.connect(this.clockDepth).connect(this.gate.gain);

    this.tone = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: this.#toneHz(p.tone), Q: -3 });
    into.connect(this.pre).connect(stairs).connect(this.post).connect(this.gate)
      .connect(this.tone).connect(this.wet).connect(this.output);

    for (const node of [this.crackleSource, this.bits, this.clock]) node.start();
  }

  /** A lowpass at Nyquist passes everything untouched; one at 20 kHz would still shift phase. */
  #toneHz(value) {
    return value >= TONE_OPEN ? this.ctx.sampleRate / 2 : value;
  }

  applyParam(name, value, time) {
    switch (name) {
      case 'bits': this.bits.offset.setTargetAtTime(bitsToSignal(value), time, SMOOTH); break;
      case 'rate':
        this.clock.frequency.setTargetAtTime(value, time, SMOOTH);
        this.clockDepth.gain.setTargetAtTime(rateDepth(value), time, SMOOTH);
        break;
      case 'tone': this.tone.frequency.setTargetAtTime(this.#toneHz(value), time, SMOOTH); break;
      case 'crackle': this.crackle.gain.setTargetAtTime(crackleGain(value), time, SMOOTH); break;
      case 'mix':
        this.dry.gain.setTargetAtTime(1 - value, time, SMOOTH);
        this.wet.gain.setTargetAtTime(value, time, SMOOTH);
        break;
    }
  }

  dispose() {
    for (const node of [this.crackleSource, this.bits, this.clock]) node.stop();
    super.dispose();
  }
}

const rateDepth = (rate) => (rate >= RATE_OFF ? 0 : 1);
const crackleGain = (c) => c * c * 0.5;   // squared for finer control down low
