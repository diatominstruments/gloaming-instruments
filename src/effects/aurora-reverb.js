import { Effect, num, choice } from '../module.js';
import { SMOOTH } from '../util.js';

// ---- the tank ----------------------------------------------------------------

/** Delay-line lengths (s) at 50% size: mutually prime-ish, so their echoes never line up. */
const LINES = [0.0311, 0.0373, 0.0437, 0.0509, 0.0593, 0.0673, 0.0787, 0.0887];
const N = LINES.length;
const popcount = (x) => (x ? (x & 1) + popcount(x >> 1) : 0);
/**
 * Sylvester Hadamard matrix: line i feeds line j with sign HADAMARD[j][i].
 * Scaled by 1/√8 it's orthogonal, so the mixing neither adds nor loses
 * energy, and every line reaches every other on each pass.
 */
const HADAMARD = LINES.map((_, j) => LINES.map((_, i) => (popcount(i & j) % 2 ? -1 : 1)));
/**
 * Signs left and right enter and leave the tank with: left by the even
 * lines, right by the odd ones. A panned source starts on its own side
 * before the mixing spreads it, and since the two sides read different
 * lines, their tails come out uncorrelated.
 */
const LEFT = [1, 0, -1, 0, 1, 0, -1, 0];
const RIGHT = [0, 1, 0, -1, 0, 1, 0, -1];
/** Level into the tank and out of it, so the wet signal sits near the dry one. */
const IN_GAIN = 0.55;
const OUT_GAIN = 0.55;
/** Corner of the damping shelf in each line. */
const DAMP_HZ = 3000;
/** Floor on the damping shelf's cut per pass, so short dark settings stay numerically sane. */
const MIN_DAMP_DB = -60;
/** Most a delay line swings either way (s) at full modulation depth. */
const MOD_MAX = 0.002;
/** Four LFOs at these multiples of `modRate`, each swinging two lines in opposite directions. */
const MOD_RATES = [1, 1.23, 0.81, 1.47];
/**
 * Input diffuser delays (s), rounded to whole samples when built: the
 * delay's interpolation between samples is a lowpass, which inside the
 * loop would stop the allpass passing everything evenly. Each must exceed
 * one render quantum, since it sits in a feedback loop.
 */
const DIFFUSERS = [0.0047, 0.0063, 0.0091, 0.0127];
/** Allpass gain at full diffusion, and the least it gets (its output divides by it). */
const MAX_DIFFUSION = 0.75;
const MIN_DIFFUSION = 0.05;

/** Time constant (s) for gliding line lengths: slow enough not to click when `size` moves. */
const SIZE_GLIDE = 0.05;

/** Scale on the line lengths: 0.4× at 0%, 1× at 50%, 2.5× at 100%. */
const sizeScale = (size) => 0.4 * 6.25 ** size;

// ---- shimmer -----------------------------------------------------------------

/** Span (s) the shifter's delay ramps over: longer is smoother, shorter is tighter. */
const SHIFT_WINDOW = 0.08;
/** Shortest the shifter's delay gets, clear of a render quantum and the ramp's overshoot. */
const SHIFT_MIN = 0.008;
const SHIFT_HARMONICS = 128;
/** The lines shimmer runs on, one per side; the mixing spreads what they shift to the rest. */
const SHIMMER_LINES = [6, 7];
/** How many times a second the whole tail's worth of energy gets shifted, at full shimmer. */
const SHIMMER_RATE = 3;
/** Makes up the power the shifter's crossfade loses on a noisy signal (its fades' squares average 3/4). */
const SHIFT_MAKEUP = Math.sqrt(4 / 3);
/**
 * Band the shifter works on: the lows below it stay unshifted, so shimmer
 * doesn't turn bass into mud, and nothing above it reaches the shifter to
 * alias when shifted up.
 */
const SHIMMER_LOW = 250;
const SHIMMER_HIGH = 7000;

/**
 * Pitch-shifts any number of channels with a rotating delay: two taps
 * whose delay ramps across SHIFT_WINDOW (down to shift up, up to shift
 * down), each faded out by a raised cosine while it jumps back, half a
 * cycle apart so the fades always sum to one. The ramps and the fade come
 * from three oscillators started together on one frequency, so they stay
 * locked to each other.
 */
class Shifter {
  constructor(ctx, ratio) {
    this.input = new GainNode(ctx);
    this.output = new GainNode(ctx);
    // A saw rising through zero at the start of the cycle, the same saw half
    // a cycle later, and a cosine that peaks mid-ramp of the first.
    const saw = (sign) => wave(ctx, (n) => [0, sign(n) * 2 / (Math.PI * n)]);
    const waves = [
      saw((n) => (n % 2 ? 1 : -1)),
      saw(() => -1),
      wave(ctx, (n) => [n === 1 ? 1 : 0, 0]),
    ];
    this.oscs = waves.map((periodicWave) => new OscillatorNode(ctx, { periodicWave }));
    const [sawA, sawB, cos] = this.oscs;
    const centre = SHIFT_MIN + SHIFT_WINDOW / 2;
    this.taps = [[sawA, 1], [sawB, -1]].map(([ramp, side]) => {
      const delay = new DelayNode(ctx, { maxDelayTime: SHIFT_MIN + SHIFT_WINDOW * 1.2, delayTime: centre });
      const sweep = new GainNode(ctx);
      const fade = new GainNode(ctx, { gain: 0.5 });
      ramp.connect(sweep).connect(delay.delayTime);
      cos.connect(new GainNode(ctx, { gain: side * 0.5 })).connect(fade.gain);
      this.input.connect(delay).connect(fade).connect(this.output);
      return sweep;
    });
    this.setRatio(ratio);
    const t = ctx.currentTime;
    for (const osc of this.oscs) osc.start(t);
  }

  /**
   * Frequency ratio, 2 for an octave up. Every oscillator jumps at the same
   * instant so they stay in step. `time` undefined sets values directly.
   */
  setRatio(ratio, time) {
    const hz = Math.abs(ratio - 1) / SHIFT_WINDOW;
    const sweep = (-Math.sign(ratio - 1) * SHIFT_WINDOW) / 2;
    const jump = (param, value) => (time == null ? (param.value = value) : param.setValueAtTime(value, time));
    for (const osc of this.oscs) jump(osc.frequency, hz);
    for (const tap of this.taps) jump(tap.gain, sweep);
  }

  stop() {
    for (const osc of this.oscs) osc.stop();
  }
}

/** A PeriodicWave from (n) → [cos, sin] coefficients, unnormalized. */
function wave(ctx, coefficients) {
  const real = new Float32Array(SHIFT_HARMONICS);
  const imag = new Float32Array(SHIFT_HARMONICS);
  for (let n = 1; n < SHIFT_HARMONICS; n++) [real[n], imag[n]] = coefficients(n);
  return new PeriodicWave(ctx, { real, imag, disableNormalization: true });
}

/**
 * A Schroeder allpass on `source`, which smears without colouring:
 * w = x + g·w[n−D], and y = (1/g − g)·w − x/g. That's the usual
 * y = w[n−D] − g·w with w[n−D] written as (w − x)/g, so nothing taps the
 * delay. It matters because Chrome adds a render quantum to a cycle
 * wherever it happens to break it: a tap on the delay might see a
 * different delay from the feedback, and the filter would colour the
 * sound. Built from w and x alone, it's an exact allpass either way.
 */
function allpass(ctx, source, seconds) {
  const sum = new GainNode(ctx);
  const delayTime = Math.round(seconds * ctx.sampleRate) / ctx.sampleRate;
  const delay = new DelayNode(ctx, { maxDelayTime: 0.05, delayTime });
  const back = new GainNode(ctx);
  const fromSum = new GainNode(ctx);
  const fromInput = new GainNode(ctx);
  const output = new GainNode(ctx);
  source.connect(sum).connect(delay).connect(back).connect(sum);
  sum.connect(fromSum).connect(output);
  source.connect(fromInput).connect(output);
  return { output, gains: [back, fromSum, fromInput] };
}

/** An allpass's three gains for `diffusion`: [g, 1/g − g, −1/g]. */
function allpassGains(diffusion) {
  const g = Math.max(MIN_DIFFUSION, diffusion * MAX_DIFFUSION);
  return [g, 1 / g - g, -1 / g];
}

const INTERVALS = { '7': '+5th', '12': '+1 oct', '19': '+1 oct 5th', '-12': '−1 oct' };
const ratio = (interval) => 2 ** (Number(interval) / 12);

/**
 * AuroraReverb — an algorithmic stereo reverb in the modern style: input
 * diffusion, then eight delay lines feeding each other through a Hadamard
 * matrix, each with a damping shelf and a gain that sets the decay time
 * exactly for its length. Slow LFOs swing the line lengths, which chorus
 * the tail and keep it from ringing metallic.
 *
 * Left enters and leaves by the even lines and right by the odd ones, so
 * a panned source starts on its own side and the tails of the two sides
 * come out uncorrelated: a mono source comes out wide, and `width`
 * narrows it.
 *
 * Shimmer crossfades two of the lines between themselves and a
 * pitch-shifted copy before the mixing, which spreads the shifted signal
 * through the tank, so the tail climbs another interval every so often.
 * A crossfade rather than an extra feed means the shimmer can't pile up
 * energy (whatever it shifts moves on, and out through the band limits),
 * so the tank stays stable at any setting, frozen included.
 * Freeze holds every line at unity gain with no damping and shuts the
 * input out, so the tail rings on until it's released.
 *
 * Everything is delays, gains and filters (no convolution, no noise), so it
 * renders identically everywhere. `size` glides the line lengths, which
 * bends a ringing tail's pitch like a delay's time knob.
 */
export class AuroraReverb extends Effect {
  static id = 'aurora-reverb';
  static label = 'Aurora Reverb';
  static description = 'Lush stereo algorithmic reverb with a modulated tail, shimmer and freeze. Halls, plates, clouds and ambient washes.';
  static tags = ['space', 'modulation'];
  static params = {
    size: num(0, 1, 0.5, {
      unit: '%', label: 'Size', description: 'Room dimensions: small is tight and dense, large spaces out the reflections.',
    }),
    decay: num(0.2, 30, 3, {
      unit: 's', scale: 'log', primary: true, label: 'Decay', description: 'Time for the tail to fall by 60 dB.',
    }),
    damping: num(0, 1, 0.4, {
      unit: '%', label: 'Damping', description: 'How much sooner the highs die away than the rest.',
    }),
    diffusion: num(0, 1, 0.7, {
      unit: '%', label: 'Diffusion', description: 'Blurs the attack: low keeps distinct early echoes, high melts straight into the wash.',
    }),
    preDelay: num(0, 0.5, 0.02, {
      unit: 's', label: 'Pre-delay', description: 'Gap before the reverb starts.',
    }),
    freeze: choice(['off', 'on'], 'off', {
      label: 'Freeze', description: 'Holds the tail indefinitely and ignores new input.',
      labels: { off: 'Off', on: 'On' },
    }),
    modDepth: num(0, 1, 0.4, {
      unit: '%', label: 'Depth', description: 'How far the delay lines drift, for a lush, chorused tail.',
    }),
    modRate: num(0.05, 5, 0.6, {
      unit: 'Hz', scale: 'log', label: 'Rate', description: 'Speed of the drift.',
    }),
    shimmer: num(0, 1, 0, {
      unit: '%', primary: true,
      label: 'Amount', description: 'How much of the tail is pitch-shifted on each pass, so it climbs as it rings.',
    }),
    interval: choice(Object.keys(INTERVALS), '12', {
      label: 'Interval', description: 'How far each pass shifts the shimmer.', labels: INTERVALS,
    }),
    width: num(0, 1, 1, {
      unit: '%', label: 'Width', description: 'Stereo spread of the tail, from mono to fully wide.',
    }),
    mix: num(0, 1, 0.3, {
      unit: '%', primary: true, label: 'Mix', description: 'Reverb against the dry signal.',
    }),
  };
  static groups = [
    { id: 'space', label: 'Space', params: ['size', 'decay', 'damping', 'diffusion', 'preDelay', 'freeze'] },
    { id: 'mod', label: 'Modulation', params: ['modDepth', 'modRate'] },
    { id: 'shimmer', label: 'Shimmer', params: ['shimmer', 'interval'] },
    { id: 'output', label: 'Output', params: ['width', 'mix'] },
  ];
  static presets = {
    'Room': { size: 0.15, decay: 0.8, damping: 0.5, diffusion: 0.6, preDelay: 0.005, modDepth: 0.15, mix: 0.2 },
    'Plate': { size: 0.35, decay: 2.2, damping: 0.2, diffusion: 0.85, preDelay: 0.01, modDepth: 0.25, mix: 0.25 },
    'Hall': { size: 0.6, decay: 3.5, damping: 0.45, diffusion: 0.7, preDelay: 0.03, modDepth: 0.35, mix: 0.3 },
    'Shimmer': {
      size: 0.7, decay: 8, damping: 0.3, diffusion: 0.8, preDelay: 0.04, modDepth: 0.5,
      shimmer: 0.45, interval: '12', mix: 0.4,
    },
    'Cloud': {
      size: 0.9, decay: 16, damping: 0.5, diffusion: 1, preDelay: 0.06, modDepth: 0.8, modRate: 0.3,
      shimmer: 0.25, interval: '19', mix: 0.45,
    },
    'Undertow': {
      size: 0.75, decay: 7, damping: 0.6, diffusion: 0.8, modDepth: 0.5, modRate: 0.4,
      shimmer: 0.4, interval: '-12', mix: 0.35,
    },
  };

  constructor(ctx, params) {
    super(ctx, params);
    const p = this.params;
    this.dry = new GainNode(ctx, { gain: 1 - p.mix });
    this.wet = new GainNode(ctx, { gain: p.mix });
    this.input.connect(this.dry).connect(this.output);

    // In: made stereo (a mono source feeds both sides), pre-delayed,
    // diffused, then the freeze gate.
    const stereo = new GainNode(ctx, { channelCount: 2, channelCountMode: 'explicit', channelInterpretation: 'speakers' });
    this.pre = new DelayNode(ctx, { maxDelayTime: 0.5, delayTime: p.preDelay });
    this.input.connect(stereo).connect(this.pre);
    let last = this.pre;
    this.diffusers = DIFFUSERS.map((time) => {
      const stage = allpass(ctx, last, time);
      last = stage.output;
      return stage;
    });
    this.#diffuse(p.diffusion);
    this.gate = new GainNode(ctx, { gain: p.freeze === 'on' ? 0 : 1 });
    const sides = new ChannelSplitterNode(ctx, { numberOfOutputs: 2 });
    last.connect(this.gate).connect(sides);

    // The lines: delay → damping → decay, all gathered into one 8-channel
    // hub, then split back out, plain and inverted, so a matrix entry of
    // either sign is just a connection. Every path round the tank crosses
    // the hub, which keeps the mixing exact in Chrome: it adds a render
    // quantum where it breaks a cycle, and with one hub, every path gets
    // it alike (it just lengthens each line a little).
    this.lines = LINES.map(() => ({
      delay: new DelayNode(ctx, { maxDelayTime: 0.5 }),
      damp: new BiquadFilterNode(ctx, { type: 'highshelf', frequency: DAMP_HZ }),
      decay: new GainNode(ctx),
    }));
    const hub = new ChannelMergerNode(ctx, { numberOfInputs: N });
    this.lines.forEach((line, i) => {
      line.delay.connect(line.damp).connect(line.decay);
      if (!SHIMMER_LINES.includes(i)) line.decay.connect(hub, 0, i);
    });

    // Shimmer: the shimmer lines, as one stereo signal, crossfaded with
    // their shifted copy on the way into the hub.
    const gather = new ChannelMergerNode(ctx, { numberOfInputs: SHIMMER_LINES.length });
    SHIMMER_LINES.forEach((i, k) => this.lines[i].decay.connect(gather, 0, k));
    this.direct = new GainNode(ctx);
    this.shifted = new GainNode(ctx);
    this.restore = new GainNode(ctx);
    this.shifter = new Shifter(ctx, ratio(p.interval));
    const crossfade = new GainNode(ctx);
    gather.connect(this.direct).connect(crossfade);
    gather
      .connect(new BiquadFilterNode(ctx, { type: 'highpass', frequency: SHIMMER_LOW, Q: -3 }))
      .connect(new BiquadFilterNode(ctx, { type: 'lowpass', frequency: SHIMMER_HIGH, Q: -3 }))
      .connect(this.shifter.input);
    this.shifter.output.connect(this.shifted).connect(crossfade);
    // The lows the shifter's highpass drops go back in direct, so shimmer
    // doesn't drain the bass from the tail.
    gather
      .connect(new BiquadFilterNode(ctx, { type: 'lowpass', frequency: SHIMMER_LOW, Q: -3 }))
      .connect(this.restore)
      .connect(crossfade);
    const scatter = new ChannelSplitterNode(ctx, { numberOfOutputs: SHIMMER_LINES.length });
    crossfade.connect(scatter);
    SHIMMER_LINES.forEach((i, k) => scatter.connect(hub, k, i));

    const plus = new ChannelSplitterNode(ctx, { numberOfOutputs: N });
    const minus = new ChannelSplitterNode(ctx, { numberOfOutputs: N });
    hub.connect(plus);
    hub.connect(new GainNode(ctx, { gain: -1 })).connect(minus);
    const send = (i, sign, to) => (sign > 0 ? plus : minus).connect(to, i);
    this.lines.forEach((line, j) => HADAMARD[j].forEach((sign, i) => send(i, sign, line.delay)));

    // Each side into its lines (through an inverse for the minus signs),
    // and out of the same ones.
    const merger = new ChannelMergerNode(ctx, { numberOfInputs: 2 });
    this.pan = [LEFT, RIGHT].map((row, side) => {
      const feed = new GainNode(ctx, { gain: IN_GAIN });
      const feedInverse = new GainNode(ctx, { gain: -1 });
      sides.connect(feed, side);
      feed.connect(feedInverse);
      row.forEach((sign, i) => sign && (sign > 0 ? feed : feedInverse).connect(this.lines[i].delay));

      const tap = new GainNode(ctx, { gain: OUT_GAIN });
      row.forEach((sign, i) => sign && send(i, sign, tap));
      // [to own side, to the other], as on the ping-pong delay.
      return spread(p.width).map((gain, k) => {
        const node = new GainNode(ctx, { gain });
        tap.connect(node).connect(merger, 0, k ? 1 - side : side);
        return node;
      });
    });
    merger.connect(this.wet).connect(this.output);

    // Modulation: each LFO swings line i one way and line i + 4 the other.
    this.lfos = MOD_RATES.map((r) => new OscillatorNode(ctx, { frequency: p.modRate * r }));
    this.swings = this.lines.map((line, i) => {
      const swing = new GainNode(ctx, { gain: (i < N / 2 ? 1 : -1) * p.modDepth * MOD_MAX });
      this.lfos[i % MOD_RATES.length].connect(swing).connect(line.delay.delayTime);
      return swing;
    });
    for (const lfo of this.lfos) lfo.start();

    this.#tune();
    this.#shimmer();
  }

  /**
   * Set each line's length, decay gain and damping from size, decay,
   * damping and freeze. Gain per pass is 10^(-3·length/decay), so every
   * line falls 60 dB in `decay` whatever its length; the shelf takes the
   * highs down faster, to fall 60 dB in `decay × (1 - 0.9 × damping)`.
   * The 1/√8 that makes the mixing orthogonal rides on the decay gain.
   * `time` undefined sets values directly.
   */
  #tune(time) {
    const { size, decay, damping, freeze } = this.params;
    const frozen = freeze === 'on';
    const scale = sizeScale(size);
    const highDecay = decay * (1 - 0.9 * damping);
    this.lines.forEach((line, i) => {
      const length = LINES[i] * scale;
      const gain = frozen ? 1 : 10 ** ((-3 * length) / decay);
      const shelf = frozen ? 0 : Math.max(MIN_DAMP_DB, -60 * length * (1 / highDecay - 1 / decay));
      set(line.delay.delayTime, length, time, SIZE_GLIDE);
      set(line.decay.gain, gain / Math.sqrt(N), time);
      set(line.damp.gain, shelf, time);
    });
  }

  #diffuse(diffusion, time) {
    const gains = allpassGains(diffusion);
    for (const stage of this.diffusers) stage.gains.forEach((node, k) => set(node.gain, gains[k], time));
  }

  /**
   * The shimmer crossfade on the shimmer lines. `shimmer` sets a rate: at
   * full, the tail's energy is shifted SHIMMER_RATE times a second,
   * whatever the size. A pass round the tank takes about the mean line
   * length, and the shimmer lines carry 2/8 of the energy, so they shift
   * four times the tank's share per pass. The fade is power-complementary,
   * as the shifted signal is uncorrelated with the direct one, so the
   * crossfade itself never adds or loses energy. What the fade takes from
   * the lows comes back through a lowpass: `direct + restore × lowpass`
   * never exceeds unity, as a Butterworth lowpass never does.
   */
  #shimmer(time) {
    const { shimmer, size } = this.params;
    const pass = (LINES.reduce((a, b) => a + b) / N) * sizeScale(size);
    const tankShare = 1 - Math.exp(-shimmer * SHIMMER_RATE * pass);
    const share = Math.min(1, (tankShare * N) / SHIMMER_LINES.length);
    const direct = Math.sqrt(1 - share);
    set(this.direct.gain, direct, time);
    set(this.restore.gain, 1 - direct, time);
    set(this.shifted.gain, Math.sqrt(share) * SHIFT_MAKEUP, time);
  }

  applyParam(name, value, time) {
    switch (name) {
      case 'size':
        this.#tune(time);
        this.#shimmer(time);
        break;
      case 'decay':
      case 'damping':
        this.#tune(time);
        break;
      case 'freeze':
        this.gate.gain.setTargetAtTime(value === 'on' ? 0 : 1, time, SMOOTH);
        this.#tune(time);
        break;
      case 'diffusion': this.#diffuse(value, time); break;
      case 'preDelay': this.pre.delayTime.setTargetAtTime(value, time, SMOOTH); break;
      case 'modDepth':
        this.swings.forEach((swing, i) => swing.gain.setTargetAtTime((i < N / 2 ? 1 : -1) * value * MOD_MAX, time, SMOOTH));
        break;
      case 'modRate':
        this.lfos.forEach((lfo, i) => lfo.frequency.setTargetAtTime(value * MOD_RATES[i], time, SMOOTH));
        break;
      case 'shimmer': this.#shimmer(time); break;
      case 'interval': this.shifter.setRatio(ratio(value), time); break;
      case 'width':
        for (const side of this.pan) spread(value).forEach((gain, k) => side[k].gain.setTargetAtTime(gain, time, SMOOTH));
        break;
      case 'mix':
        this.dry.gain.setTargetAtTime(1 - value, time, SMOOTH);
        this.wet.gain.setTargetAtTime(value, time, SMOOTH);
        break;
    }
  }

  dispose() {
    for (const lfo of this.lfos) lfo.stop();
    this.shifter.stop();
    super.dispose();
  }
}

// Width 1 keeps each side to itself; width 0 splits it equally.
const spread = (width) => [(1 + width) / 2, (1 - width) / 2];

/** Set a param now (`time` undefined), or glide it there from `time`. */
function set(param, value, time, glide = SMOOTH) {
  if (time == null) param.value = value;
  else param.setTargetAtTime(value, time, glide);
}
