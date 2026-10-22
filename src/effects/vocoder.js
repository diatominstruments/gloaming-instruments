import { Effect, num, choice } from '../module.js';
import { mtof, noiseBuffer, SMOOTH } from '../util.js';
import { CHORDS, chordLabels } from './resonator.js';

/** Centres of the lowest and highest bands; the rest are spaced evenly in log-frequency between. */
const LOW_HZ = 120;
const HIGH_HZ = 7000;
/** The sibilance band: the voice above this passes straight through, so consonants survive. */
const SIBILANCE_HZ = 6500;
/** Overall level, so a voice comes out of the chord carrier near its own level at `level` 0 dB. */
const TRIM = 19;
/** Band levels are compensated toward a flat spectrum around this frequency. */
const TILT_REF = 1000;
/** Rectifier input scale: the curve spans ±RECTIFY, so loud bands don't clip their follower. */
const RECTIFY = 4;

/**
 * Each carrier's band level goes as f^slope across log-spaced bands: a
 * saw's harmonics fall as 1/n but crowd closer per band as they rise
 * (−½), while white noise has equal power per Hz, so wider bands pass more
 * (+½). External carriers are taken to be saw-like synths. Each band is
 * compensated by the opposite slope, so every carrier sounds balanced.
 */
const CARRIER_SLOPES = { chord: -0.5, noise: 0.5, external: -0.5 };

let rectifier = null;

/** |x| across ±RECTIFY, for the envelope followers. */
function absCurve() {
  if (!rectifier) {
    rectifier = new Float32Array(4097);
    for (let i = 0; i < rectifier.length; i++) rectifier[i] = Math.abs(((i / (rectifier.length - 1)) * 2 - 1) * RECTIFY);
  }
  return rectifier;
}

/**
 * Two bandpasses in series, each with this share of the Q one would need
 * alone, make a band of the same −3 dB width with steeper skirts:
 * cascading narrows a bandpass's width by √(√2 − 1).
 */
const CASCADE = Math.sqrt(Math.SQRT2 - 1);

/**
 * Vocoder — makes one sound speak through another. The input, the
 * modulator (a voice, usually), is split into `bands` bands spread
 * evenly in pitch from 120 Hz to 7 kHz, and an envelope follower measures
 * each one's level moment to moment. The carrier is split into the same
 * bands, and each carrier band is turned up and down by its follower, so
 * the carrier takes on the shape of the voice's spectrum: its vowels and
 * consonants, at the carrier's pitch.
 *
 * The carrier is a chord of detuned saws built in (`root` and `chord`, as
 * on the resonator), white noise for a whisper, or whatever the app
 * connects to `sidechain` when `carrier` is 'external':
 *
 *   synth.output.connect(vocoder.sidechain);
 *
 * Each band of the carrier is compensated for how a saw's or noise's
 * spectrum falls or rises across the bands, so all of them come out
 * balanced, and the bank's gain follows the band count and width, so
 * neither changes the level much.
 *
 * `shift` moves the carrier's bands against the voice's, which moves its
 * formants: up is a smaller throat, down a bigger one. `width` widens or
 * narrows every band; `response` is how quickly the followers track,
 * crisp and clicky to smooth and slurred. `sibilance` lets the voice's
 * own top end through, which no saw carrier has, so s and t stay clear.
 *
 * Every follower is a rectifier and a lowpass, as on the auto-wah, so the
 * whole thing is standard nodes and renders offline. One response time
 * serves both rise and fall: Web Audio has no way to build a follower
 * with separate attack and release from its nodes.
 */
export class Vocoder extends Effect {
  static id = 'vocoder';
  static label = 'Vocoder';
  static description = 'Makes the input speak through a carrier: a built-in chord, noise, or another track on the sidechain. Robot voices, talking synths and choirs.';
  static tags = ['filter', 'modulation', 'character'];
  static sidechain = {
    label: 'Carrier',
    description: 'The sound the input speaks through, when Carrier is External: usually a held synth chord.',
    activeWhen: { carrier: 'external' },
  };
  static params = {
    carrier: choice(['chord', 'noise', 'external'], 'chord', {
      label: 'Carrier', description: 'What the input speaks through: a built-in chord, noise for a whisper, or the sidechain.',
      labels: { chord: 'Chord', noise: 'Noise', external: 'External' },
    }),
    root: num(24, 84, 48, {
      unit: 'note', primary: true, activeWhen: { carrier: 'chord' },
      label: 'Root', description: 'The note the built-in chord is built on. Glides when moved.',
    }),
    chord: choice(Object.keys(CHORDS), 'minor', {
      activeWhen: { carrier: 'chord' }, label: 'Chord', description: 'The notes of the built-in carrier.',
      labels: chordLabels(),
    }),
    wave: choice(['sawtooth', 'square'], 'sawtooth', {
      activeWhen: { carrier: 'chord' }, label: 'Wave', description: 'Shape of the chord\'s oscillators: saw is brightest, square hollower.',
      labels: { sawtooth: 'Saw', square: 'Square' },
    }),
    detune: num(0, 50, 12, {
      unit: 'ct', activeWhen: { carrier: 'chord' },
      label: 'Detune', description: 'Spread between the two oscillators on each note; more is thicker and more ensemble-like.',
    }),
    bands: choice(['8', '12', '16', '24', '32'], '16', {
      label: 'Bands', description: 'How finely the spectrum is split: fewer is vintage and robotic, more is clearer.',
    }),
    shift: num(-12, 12, 0, {
      unit: 'st', center: 0, label: 'Shift', description: 'Moves the formants: up is a smaller throat, down a bigger one.',
    }),
    width: num(0.5, 2, 1, {
      unit: '×', label: 'Width', description: 'Band width: narrow is more resonant and pitched, wide is smoother.',
    }),
    response: num(0.003, 0.2, 0.015, {
      unit: 's', scale: 'log', label: 'Response', description: 'How quickly the bands follow the input: short is crisp, long is smooth and slurred.',
    }),
    sibilance: num(0, 1, 0.3, {
      unit: '%', label: 'Sibilance', description: 'The input\'s own top end, passed straight through, so consonants stay clear.',
    }),
    level: num(-24, 12, 0, {
      unit: 'dB', center: 0, label: 'Level', description: 'Level of the vocoded sound.',
    }),
    mix: num(0, 1, 1, {
      unit: '%', primary: true, label: 'Mix', description: 'Vocoded against the dry input.',
    }),
  };
  static groups = [
    { id: 'carrier', label: 'Carrier', params: ['carrier', 'root', 'chord', 'wave', 'detune'] },
    { id: 'bands', label: 'Bands', params: ['bands', 'shift', 'width', 'response'] },
    { id: 'output', label: 'Output', params: ['sibilance', 'level', 'mix'] },
  ];
  static presets = {
    'Robot': { carrier: 'chord', chord: 'unison', root: 45, wave: 'square', detune: 0, bands: '8', response: 0.01, sibilance: 0.2 },
    'Choir': { carrier: 'chord', chord: 'minor', root: 48, detune: 18, bands: '24', width: 1.2, response: 0.03, sibilance: 0.3 },
    'Classic': { carrier: 'chord', chord: 'maj7', root: 48, detune: 10, bands: '16', response: 0.015, sibilance: 0.35 },
    'Whisper': { carrier: 'noise', bands: '24', response: 0.01, sibilance: 0.4 },
    'Giant': { carrier: 'chord', chord: 'fifth', root: 36, detune: 14, bands: '16', shift: -7, response: 0.025, sibilance: 0.2 },
    'Chipmunk': { carrier: 'chord', chord: 'major', root: 60, bands: '16', shift: 7, response: 0.01, sibilance: 0.4 },
    'External': { carrier: 'external', bands: '16', response: 0.015, sibilance: 0.3 },
  };

  constructor(ctx, params) {
    super(ctx, params);
    const p = this.params;
    this.dry = new GainNode(ctx, { gain: 1 - p.mix });
    this.wet = new GainNode(ctx, { gain: p.mix });
    this.input.connect(this.dry).connect(this.output);

    // The modulator, summed to mono; the carriers, each through its own
    // switch into one bus.
    this.modulator = new GainNode(ctx, { channelCount: 1, channelCountMode: 'explicit', channelInterpretation: 'speakers' });
    this.input.connect(this.modulator);
    this.carrierBus = new GainNode(ctx, { channelCount: 1, channelCountMode: 'explicit', channelInterpretation: 'speakers' });
    this.switches = Object.fromEntries(Object.keys(CARRIER_SLOPES).map((key) => {
      const gain = new GainNode(ctx, { gain: key === p.carrier ? 1 : 0 });
      gain.connect(this.carrierBus);
      return [key, gain];
    }));
    this.noise = new AudioBufferSourceNode(ctx, { buffer: noiseBuffer(ctx), loop: true });
    this.noise.connect(this.switches.noise);
    this.noise.start();
    this.sidechain.connect(this.switches.external);
    this.chordLevel = new GainNode(ctx);
    this.chordLevel.connect(this.switches.chord);
    this.#buildChord();

    // The bands sum into the level, joined by the sibilance band.
    this.level = new GainNode(ctx, { gain: dbToGain(p.level) });
    this.level.connect(this.wet).connect(this.output);
    this.sibilance = new GainNode(ctx, { gain: p.sibilance });
    this.modulator
      .connect(new BiquadFilterNode(ctx, { type: 'highpass', frequency: SIBILANCE_HZ, Q: -3 }))
      .connect(new BiquadFilterNode(ctx, { type: 'highpass', frequency: SIBILANCE_HZ, Q: -3 }))
      .connect(this.sibilance)
      .connect(this.wet);
    this.#buildBands();
  }

  /** Two detuned oscillators per chord note, replacing any already running. */
  #buildChord() {
    const { chord, wave } = this.params;
    if (this.oscs) {
      for (const { osc } of this.oscs) osc.stop();
    }
    const intervals = CHORDS[chord].intervals;
    // Uncorrelated oscillators add in power: this keeps the chord at one saw's level.
    this.chordLevel.gain.value = 1 / Math.sqrt(intervals.length * 2);
    this.oscs = intervals.flatMap((interval) => [-1, 1].map((side) => {
      const osc = new OscillatorNode(this.ctx, { type: wave, frequency: mtof(this.params.root + interval) });
      osc.detune.value = (side * this.params.detune) / 2;
      osc.connect(this.chordLevel);
      osc.start();
      return { osc, interval, side };
    }));
  }

  /**
   * One band per `bands`: the modulator through a cascaded bandpass, a
   * rectifier and a smoothing lowpass, driving the gain of the carrier
   * through the matching bandpass. Replaces any bank already built.
   */
  #buildBands() {
    const ctx = this.ctx;
    if (this.bandsIn) {
      this.modulator.disconnect(this.bandsIn.modulator);
      this.carrierBus.disconnect(this.bandsIn.carrier);
      for (const band of this.bankList) band.out.disconnect();
    }
    this.bandsIn = { modulator: new GainNode(ctx), carrier: new GainNode(ctx) };
    this.modulator.connect(this.bandsIn.modulator);
    this.carrierBus.connect(this.bandsIn.carrier);

    const n = Number(this.params.bands);
    const curve = absCurve();
    this.bankList = Array.from({ length: n }, (_, k) => {
      const hz = LOW_HZ * (HIGH_HZ / LOW_HZ) ** (k / (n - 1));
      const pair = () => [0, 1].map(() => new BiquadFilterNode(ctx, { type: 'bandpass', frequency: hz }));
      const analysis = pair();
      const synthesis = pair();
      const follower = new BiquadFilterNode(ctx, { type: 'lowpass', Q: -6 });
      const scale = new GainNode(ctx);
      const out = new GainNode(ctx, { gain: 0 });
      this.bandsIn.modulator.connect(analysis[0]).connect(analysis[1])
        .connect(new GainNode(ctx, { gain: 1 / RECTIFY }))
        .connect(new WaveShaperNode(ctx, { curve }))
        .connect(follower)
        .connect(scale)
        .connect(out.gain);
      this.bandsIn.carrier.connect(synthesis[0]).connect(synthesis[1]).connect(out).connect(this.level);
      return { hz, analysis, synthesis, follower, scale, out };
    });
    this.#tune();
  }

  /**
   * Every band's filters and gain. Bands sit a ratio r apart, so a band's
   * own width is f·(√r − 1/√r), and `width` scales it. The bank's gain goes
   * as √n / width: each band of carrier and of voice passes amplitude in
   * proportion to √(its width), and n of them add in power. `time`
   * undefined sets values directly.
   */
  #tune(time) {
    const { bands, shift, width, response, carrier } = this.params;
    const n = Number(bands);
    const ratio = (HIGH_HZ / LOW_HZ) ** (1 / (n - 1));
    const q = (CASCADE / (Math.sqrt(ratio) - 1 / Math.sqrt(ratio))) / width;
    const moved = 2 ** (shift / 12);
    const top = this.ctx.sampleRate * 0.45;
    const slope = CARRIER_SLOPES[carrier];
    const bank = (TRIM * Math.sqrt(n / 16)) / width;
    for (const band of this.bankList) {
      const synthHz = Math.min(band.hz * moved, top);
      for (const f of band.analysis) { set(f.frequency, band.hz, time); set(f.Q, q, time); }
      for (const f of band.synthesis) { set(f.frequency, synthHz, time); set(f.Q, q, time); }
      set(band.follower.frequency, 1 / (2 * Math.PI * response), time);
      set(band.scale.gain, bank * (synthHz / TILT_REF) ** -slope, time);
    }
  }

  applyParam(name, value, time) {
    switch (name) {
      case 'carrier':
        for (const [key, gain] of Object.entries(this.switches)) gain.gain.setTargetAtTime(key === value ? 1 : 0, time, SMOOTH);
        this.#tune(time);
        break;
      case 'root':
        for (const { osc, interval } of this.oscs) osc.frequency.setTargetAtTime(mtof(value + interval), time, SMOOTH);
        break;
      case 'detune':
        for (const { osc, side } of this.oscs) osc.detune.setTargetAtTime((side * value) / 2, time, SMOOTH);
        break;
      case 'chord':
      case 'wave':
        this.#buildChord();
        break;
      case 'bands': this.#buildBands(); break;
      case 'shift':
      case 'width':
      case 'response':
        this.#tune(time);
        break;
      case 'sibilance': this.sibilance.gain.setTargetAtTime(value, time, SMOOTH); break;
      case 'level': this.level.gain.setTargetAtTime(dbToGain(value), time, SMOOTH); break;
      case 'mix':
        this.dry.gain.setTargetAtTime(1 - value, time, SMOOTH);
        this.wet.gain.setTargetAtTime(value, time, SMOOTH);
        break;
    }
  }

  dispose() {
    for (const { osc } of this.oscs) osc.stop();
    this.noise.stop();
    super.dispose();
  }
}

const dbToGain = (db) => 10 ** (db / 20);

/** Set a param now (`time` undefined), or glide it there from `time`. */
function set(param, value, time) {
  if (time == null) param.value = value;
  else param.setTargetAtTime(value, time, SMOOTH);
}
