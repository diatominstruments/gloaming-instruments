import { Instrument, num, choice } from '../module.js';
import { mtof, envStart, envRelease, noiseBuffer, rng, SMOOTH } from '../util.js';

const MAX_VOICES = 8;
/** Narrowest the pulse gets, as a share of the cycle, however far PWM pushes it. */
const MAX_WIDTH = 0.95;
/** Key tracking pivots here: at 100%, the cutoff doubles per octave above middle C. */
const KEY_TRACK_ROOT = mtof(60);
/** Scales the voice's mix on its way into the drive, so a full mix lands in its sweet spot. */
const MIX_LEVEL = 0.5;
/** Cross-mod at 100%: osc 2 swings osc 1's frequency by this multiple of the note's frequency. */
const CROSS_MOD = 2;
/** At full drift, how far each voice's pitch (cents) and cutoff (octaves) may stray. */
const DRIFT_CENTS = 10;
const DRIFT_OCT = 0.3;
/** Drive's tanh spans ±DRIVE_RANGE across the shaper's input. */
const DRIVE_RANGE = 8;

/**
 * Each voice slot's fixed character, [pitch, cutoff] in -1..1, scaled by
 * `drift`. Seeded, and slots are handed out in turn, so a song's chords
 * drift the same way on every play.
 */
const DRIFTS = (() => {
  const random = rng(0xc0a1);
  return Array.from({ length: MAX_VOICES }, () => [random() * 2 - 1, random() * 2 - 1]);
})();

// ---- supersaw ----------------------------------------------------------------
//
// After Adam Szabo's measurements of the JP-8000 (How to Emulate the Super
// Saw, 2010): seven saws, detuned by fixed ratios scaled by a curve on the
// detune knob, with the centre saw and the six others crossfaded by `blend`.

/** Each saw's frequency offset, as a fraction of the note, before the detune curve. */
const SAW_OFFSETS = [-0.11002313, -0.06288439, -0.01952356, 0, 0.01991221, 0.06216538, 0.10745242];
const CENTRE = 3;
/** The side each detuned saw sits on: flat and sharp saws on both, so neither side leans sharp. */
const SAW_SIDES = [0, 1, 0, null, 1, 0, 1];
/** The detuned saws are highpassed here, leaving the low end to the centre saw, osc 2 and sub: mono and solid. */
const LOW_FOCUS = 150;
const SAW_HARMONICS = 1024;

/** The JP-8000's detune curve: knob 0..1 to the scale on SAW_OFFSETS (gentle, then steep near the top). */
function detuneCurve(x) {
  const c = [0.0030115596, 0.6717417634, -24.1878824391, 404.2703938388, -3425.0836591318, 17019.951858008,
    -53046.9642751875, 106649.6679158292, -138150.6761080548, 111363.4808729368, -50818.8652045924, 10028.7312891634];
  return c.reduceRight((sum, k) => sum * x + k, 0);
}

/** The JP-8000's mix curves: `blend` 0..1 to [centre saw gain, each detuned saw's gain]. */
const blendGains = (x) => [-0.55366 * x + 0.99785, -0.73764 * x * x + 1.2841 * x + 0.044372];

const sawSets = new WeakMap();

/**
 * Seven saws starting at spread-out phases, one per saw of the stack, so a
 * note doesn't begin with all seven in step (a loud, phasey swoosh). The
 * phases are fixed, so every note sounds the same.
 */
function supersawWaves(ctx) {
  let waves = sawSets.get(ctx);
  if (!waves) {
    waves = SAW_OFFSETS.map((_, i) => {
      const phase = 2 * Math.PI * ((i * 0.618034) % 1);
      const real = new Float32Array(SAW_HARMONICS);
      const imag = new Float32Array(SAW_HARMONICS);
      for (let n = 1; n < SAW_HARMONICS; n++) {
        const b = (2 * (n % 2 ? 1 : -1)) / (Math.PI * n);
        real[n] = b * Math.sin(n * phase);
        imag[n] = b * Math.cos(n * phase);
      }
      return new PeriodicWave(ctx, { real, imag });
    });
    sawSets.set(ctx, waves);
  }
  return waves;
}

/** tanh across ±DRIVE_RANGE, so the drive's input gain sets how hard it's pushed. */
function driveCurve() {
  const curve = new Float32Array(4096);
  for (let i = 0; i < curve.length; i++) curve[i] = Math.tanh(DRIVE_RANGE * ((i / (curve.length - 1)) * 2 - 1));
  return curve;
}

/** Input gain into the tanh for `drive` 0..1: from nearly clean (0.5×) to heavily pushed (8×). */
const drivePush = (drive) => 0.5 * 16 ** drive;

/**
 * Q for a filter stage. Lowpass and highpass take Q as their peak in dB;
 * bandpass and notch take it as a plain ratio, so the same resonance
 * reads as the same peak.
 */
function stageQ(type, resonance, stages) {
  const db = resonance / stages;
  return type === 'lowpass' || type === 'highpass' ? db : 10 ** (db / 20);
}

/**
 * CumulusPoly — an eight-voice dual-oscillator polysynth in the Oberheim
 * mould: two oscillators per voice plus a sub and noise, a drive stage,
 * and a 12 dB multimode filter (or 24 dB), each with its own envelope.
 * Every voice slot is slightly out of tune and brightness with the
 * others, by `drift`, so chords breathe like an old analog.
 *
 * `mode` 'supersaw' swaps oscillator 1 for a JP-8000-style stack of seven
 * detuned saws and turns on what makes them huge without going hollow:
 * the detuned saws spread across the stereo field, and are highpassed so
 * the low end stays with the centre saw, osc 2 and the sub, mono and
 * solid.
 *
 * The pulse is a saw minus a delayed copy of itself, as on the poly synth.
 * Oscillator choices, mode, slope and keytracking are read at note-on;
 * the filter, levels, detune, blend, spread, drive and LFO depths also
 * reach notes already sounding. Past MAX_VOICES held notes the oldest is
 * stolen; released notes ring out without counting.
 */
export class CumulusPoly extends Instrument {
  static id = 'cumulus-poly';
  static label = 'Cumulus Poly';
  static description = 'Fat dual-oscillator polysynth with a multimode filter and analog drift, plus a wide supersaw mode with a solid low end. Brass, stabs, pads and big bright chords.';
  static tags = ['pad', 'keys', 'lead'];
  static polyphony = MAX_VOICES;
  static params = {
    mode: choice(['dual', 'supersaw'], 'dual', {
      primary: true, label: 'Mode',
      description: 'Dual is two oscillators per voice; Supersaw makes oscillator 1 a wide stack of seven detuned saws.',
      labels: { dual: 'Dual', supersaw: 'Supersaw' },
    }),
    osc1Wave: choice(['sawtooth', 'pulse'], 'sawtooth', {
      activeWhen: { mode: 'dual' }, label: 'Osc 1', description: 'Shape of oscillator 1.',
      labels: { sawtooth: 'Saw', pulse: 'Pulse' },
    }),
    osc2Wave: choice(['sawtooth', 'pulse', 'triangle'], 'sawtooth', {
      label: 'Osc 2', description: 'Shape of oscillator 2.',
      labels: { sawtooth: 'Saw', pulse: 'Pulse', triangle: 'Triangle' },
    }),
    width: num(0.5, MAX_WIDTH, 0.5, {
      unit: '%', label: 'Width', description: 'Duty cycle of either pulse: 50% is square, higher is thinner and nasal.',
    }),
    osc2Tune: num(-24, 24, 0, {
      unit: 'st', center: 0, label: 'Tune', description: 'Oscillator 2 relative to the note: 7 is a fifth up, -12 an octave down.',
    }),
    osc2Detune: num(-50, 50, 8, {
      unit: 'ct', center: 0, label: 'Detune', description: 'Fine offset of oscillator 2, so the two beat against each other.',
    }),
    crossMod: num(0, 1, 0, {
      unit: '%', activeWhen: { mode: 'dual' },
      label: 'Cross-mod', description: 'Oscillator 2 bends oscillator 1\'s frequency, for clangour and grit.',
    }),
    detune: num(0, 1, 0.4, {
      unit: '%', activeWhen: { mode: 'supersaw' },
      label: 'Detune', description: 'How far the stack\'s saws spread from the note; gentle at first, wild near the top.',
    }),
    blend: num(0, 1, 0.6, {
      unit: '%', activeWhen: { mode: 'supersaw' },
      label: 'Blend', description: 'The centre saw against the six detuned ones.',
    }),
    spread: num(0, 1, 0.8, {
      unit: '%', activeWhen: { mode: 'supersaw' },
      label: 'Spread', description: 'How wide the detuned saws sit in the stereo field.',
    }),
    osc1Level: num(0, 1, 1, { unit: '%', label: 'Osc 1', description: 'Level of oscillator 1 (or the stack).' }),
    osc2Level: num(0, 1, 0.7, { unit: '%', label: 'Osc 2', description: 'Level of oscillator 2.' }),
    sub: num(0, 1, 0.2, { unit: '%', label: 'Sub', description: 'An octave below, for weight.' }),
    subWave: choice(['sine', 'square'], 'sine', {
      label: 'Sub wave', description: 'Sine is pure low end; square adds body.',
      labels: { sine: 'Sine', square: 'Square' },
    }),
    noise: num(0, 1, 0, { unit: '%', label: 'Noise', description: 'White noise, for breath and hiss.' }),
    drive: num(0, 1, 0.2, {
      unit: '%', label: 'Drive', description: 'Saturates each voice before the filter: thicker, louder harmonics.',
    }),
    filterType: choice(['lowpass', 'bandpass', 'highpass', 'notch'], 'lowpass', {
      label: 'Type', description: 'What the filter keeps: lows, a band, highs, or everything but a notch.',
      labels: { lowpass: 'Lowpass', bandpass: 'Bandpass', highpass: 'Highpass', notch: 'Notch' },
    }),
    slope: choice(['12', '24'], '12', {
      label: 'Slope', description: '12 dB is open and bright, the Oberheim sound; 24 dB is steeper and smoother.',
      labels: { '12': '12 dB', '24': '24 dB' },
    }),
    cutoff: num(30, 16000, 2500, {
      unit: 'Hz', scale: 'log', primary: true,
      label: 'Cutoff', description: 'Filter frequency before the envelope and LFO move it.',
    }),
    resonance: num(0, 25, 3, {
      unit: 'dB', primary: true, label: 'Resonance', description: 'Peak at the cutoff.',
    }),
    keyTrack: num(0, 1, 0.5, {
      unit: '%', label: 'Key track', description: 'How much the cutoff follows the note; at 100%, an octave up doubles it.',
    }),
    envMod: num(-4, 6, 2, {
      unit: 'oct', center: 0, label: 'Amount',
      description: 'How far the filter envelope moves the cutoff; negative closes it instead.',
    }),
    filterAttack: num(0.001, 3, 0.005, {
      unit: 's', scale: 'log', label: 'Attack', description: 'Rise of the filter envelope.',
    }),
    filterDecay: num(0.01, 8, 0.5, {
      unit: 's', scale: 'log', label: 'Decay', description: 'Fall of the filter envelope to its sustain.',
    }),
    filterSustain: num(0, 1, 0.3, {
      unit: '%', label: 'Sustain', description: 'Filter envelope level while the note is held.',
    }),
    filterRelease: num(0.005, 8, 0.3, {
      unit: 's', scale: 'log', label: 'Release', description: 'Filter envelope fall after the note ends.',
    }),
    attack: num(0.001, 3, 0.005, {
      unit: 's', scale: 'log', label: 'Attack', description: 'Rise at the start of a note.',
    }),
    decay: num(0.01, 8, 0.5, {
      unit: 's', scale: 'log', label: 'Decay', description: 'Fall from the peak to the sustain level.',
    }),
    sustain: num(0, 1, 0.8, {
      unit: '%', label: 'Sustain', description: 'Level held while the note is held.',
    }),
    release: num(0.005, 8, 0.3, {
      unit: 's', scale: 'log', label: 'Release', description: 'Fade after the note ends.',
    }),
    lfoRate: num(0.1, 20, 5, {
      unit: 'Hz', scale: 'log', label: 'Rate', description: 'Speed of the LFO.',
    }),
    lfoDelay: num(0, 3, 0, {
      unit: 's', label: 'Delay', description: 'Time for the LFO to fade in on each note.',
    }),
    vibrato: num(0, 100, 0, {
      unit: 'ct', label: 'Vibrato', description: 'How far the LFO bends the pitch either way.',
    }),
    lfoMod: num(0, 3, 0, {
      unit: 'oct', label: 'Filter', description: 'How far the LFO sweeps the cutoff either way.',
    }),
    pwm: num(0, 1, 0, {
      unit: '%', label: 'PWM', description: 'How far the LFO sweeps either pulse\'s width toward its narrowest.',
    }),
    drift: num(0, 1, 0.3, {
      unit: '%', label: 'Drift', description: 'How far each voice strays in pitch and brightness from the others, like an old analog.',
    }),
    velocity: num(0, 1, 0.3, {
      unit: '%', label: 'Velocity',
      description: 'How much harder hits are louder and brighter; at 0 every note plays the same.',
    }),
    gain: num(0, 1, 0.2, { unit: '%', label: 'Level', description: 'Output level.' }),
  };
  static groups = [
    { id: 'osc', label: 'Oscillators', params: ['mode', 'osc1Wave', 'osc2Wave', 'width', 'osc2Tune', 'osc2Detune', 'crossMod'] },
    { id: 'supersaw', label: 'Supersaw', params: ['detune', 'blend', 'spread'] },
    { id: 'mixer', label: 'Mixer', params: ['osc1Level', 'osc2Level', 'sub', 'subWave', 'noise', 'drive'] },
    {
      id: 'filter', label: 'Filter', params: ['filterType', 'slope', 'cutoff', 'resonance', 'keyTrack'],
      role: 'filter', bind: { type: 'filterType', cutoff: 'cutoff', resonance: 'resonance' },
    },
    {
      id: 'filterEnv', label: 'Filter envelope', params: ['envMod', 'filterAttack', 'filterDecay', 'filterSustain', 'filterRelease'],
      role: 'envelope',
      bind: { attack: 'filterAttack', decay: 'filterDecay', sustain: 'filterSustain', release: 'filterRelease', amount: 'envMod' },
    },
    {
      id: 'amp', label: 'Amp envelope', params: ['attack', 'decay', 'sustain', 'release'],
      role: 'envelope', bind: { attack: 'attack', decay: 'decay', sustain: 'sustain', release: 'release' },
    },
    { id: 'lfo', label: 'LFO', params: ['lfoRate', 'lfoDelay', 'vibrato', 'lfoMod', 'pwm'] },
    { id: 'voice', label: 'Voice', params: ['drift', 'velocity', 'gain'] },
  ];
  static presets = {
    'Brass': {
      osc2Detune: 9, osc2Level: 0.8, sub: 0.2, drive: 0.3, cutoff: 500, resonance: 2, keyTrack: 0.6,
      envMod: 2.6, filterAttack: 0.07, filterDecay: 0.7, filterSustain: 0.45, filterRelease: 0.3,
      attack: 0.03, decay: 0.5, sustain: 0.9, release: 0.3, drift: 0.4, velocity: 0.4,
    },
    'Strings': {
      osc1Wave: 'pulse', osc2Wave: 'sawtooth', width: 0.6, pwm: 0.4, osc2Detune: 6, osc2Level: 0.6, sub: 0,
      cutoff: 2800, resonance: 1, keyTrack: 0.7, envMod: 0.5, filterAttack: 0.5, filterDecay: 1.5,
      attack: 0.4, decay: 1, sustain: 0.9, release: 1.2, lfoRate: 0.7, lfoDelay: 0.5, vibrato: 6, drift: 0.5,
    },
    'Stab': {
      osc2Tune: 12, osc2Detune: 5, osc2Level: 0.5, sub: 0.35, drive: 0.4, cutoff: 900, resonance: 7,
      envMod: 3.5, filterDecay: 0.25, filterSustain: 0, decay: 0.35, sustain: 0.2, release: 0.15, velocity: 0.5,
    },
    'Cross-mod lead': {
      crossMod: 0.35, osc2Tune: 7, osc2Level: 0.4, sub: 0.25, drive: 0.5, cutoff: 3500, resonance: 5,
      envMod: 1.5, filterDecay: 0.4, attack: 0.005, sustain: 0.9, release: 0.2, lfoRate: 5.5, lfoDelay: 0.4,
      vibrato: 12, gain: 0.17,
    },
    'Supersaw': {
      mode: 'supersaw', detune: 0.45, blend: 0.65, spread: 0.9, osc2Level: 0, sub: 0.4, drive: 0.2,
      cutoff: 9000, resonance: 0, envMod: 0, attack: 0.005, decay: 1, sustain: 1, release: 0.4, drift: 0.2,
    },
    'Trance pluck': {
      mode: 'supersaw', detune: 0.35, blend: 0.6, spread: 0.8, osc2Level: 0, sub: 0.3, cutoff: 700,
      resonance: 4, envMod: 4, filterDecay: 0.22, filterSustain: 0.05, decay: 0.45, sustain: 0.25, release: 0.3,
      velocity: 0.5,
    },
    'Wide pad': {
      mode: 'supersaw', detune: 0.3, blend: 0.5, spread: 1, osc2Tune: -12, osc2Level: 0.4, sub: 0.2,
      slope: '24', cutoff: 2400, resonance: 1, envMod: 1, filterAttack: 0.8, filterDecay: 2, filterSustain: 0.6,
      attack: 0.7, decay: 2, sustain: 0.85, release: 2, lfoRate: 0.3, lfoMod: 0.3, gain: 0.17,
    },
  };

  constructor(ctx, params) {
    super(ctx, params);
    const p = this.params;
    this.voices = new Map();   // held note -> voice, in start order
    this.live = new Set();     // every voice still sounding, held or releasing
    this.slot = 0;             // next drift slot to hand out
    this.lfo = new OscillatorNode(ctx, { type: 'triangle', frequency: p.lfoRate });
    this.lfo.start();
  }

  noteOn(note, velocity = 1, time) {
    const t = this.at(time);
    this.#release(note, t, 0.005);
    if (this.voices.size >= MAX_VOICES) this.#release(this.voices.keys().next().value, t, 0.005);
    const voice = this.#voice(note, velocity, t);
    this.voices.set(note, voice);
    this.live.add(voice);
  }

  noteOff(note, time) {
    this.#release(note, this.at(time), this.params.release);
  }

  allNotesOff(time) {
    const t = this.at(time);
    for (const note of [...this.voices.keys()]) this.#release(note, t, 0.005);
  }

  /**
   * One note's graph. Everything centred (osc 1 or the centre saw, osc 2,
   * sub, noise) meets in a mono bus; the supersaw's detuned saws join it
   * as a stereo pair; then drive, filter and amp, in stereo.
   */
  #voice(note, velocity, t) {
    const ctx = this.ctx;
    const p = this.params;
    const [pitchDrift, cutoffDrift] = DRIFTS[this.slot++ % MAX_VOICES];
    const hz = mtof(note);
    const touch = 1 - p.velocity * (1 - velocity);
    const v = {
      hz,
      cents: pitchDrift * p.drift * DRIFT_CENTS,
      cutoffScale: (hz / KEY_TRACK_ROOT) ** p.keyTrack * 2 ** (cutoffDrift * p.drift * DRIFT_OCT),
      sources: [],
      pitched: [],   // every oscillator the vibrato bends
      pulses: [],    // { delay, pwm, osc } for each pulse wave
    };

    v.lfoIn = new GainNode(ctx, { gain: 0 });
    v.lfoIn.gain.setValueAtTime(0, t);
    v.lfoIn.gain.linearRampToValueAtTime(1, t + Math.max(p.lfoDelay, 0.001));
    this.lfo.connect(v.lfoIn);
    v.vibrato = new GainNode(ctx, { gain: p.vibrato });
    v.lfoIn.connect(v.vibrato);

    const mix = new GainNode(ctx, { gain: MIX_LEVEL, channelCount: 2, channelCountMode: 'explicit', channelInterpretation: 'speakers' });
    const centre = new GainNode(ctx);
    centre.connect(mix);

    // Oscillator 1, or the stack.
    v.osc1 = new GainNode(ctx, { gain: p.osc1Level });
    v.osc1.connect(centre);
    let osc1 = null;
    if (p.mode === 'supersaw') {
      this.#supersaw(v, mix);
    } else {
      osc1 = this.#osc(v, 'sawtooth', v.cents);
      this.#shape(v, osc1, p.osc1Wave === 'pulse', 1).connect(v.osc1);
    }

    // Oscillator 2, which can also bend oscillator 1.
    const osc2 = this.#osc(v, p.osc2Wave === 'pulse' ? 'sawtooth' : p.osc2Wave, this.#osc2Cents(v));
    v.osc2Osc = osc2;
    v.osc2 = new GainNode(ctx, { gain: p.osc2Level });
    this.#shape(v, osc2, p.osc2Wave === 'pulse', 2).connect(v.osc2).connect(centre);
    if (osc1) {
      v.cross = new GainNode(ctx, { gain: p.crossMod * CROSS_MOD * hz });
      osc2.connect(v.cross).connect(osc1.frequency);
    }

    const sub = this.#osc(v, p.subWave, v.cents - 1200);
    v.sub = new GainNode(ctx, { gain: p.sub });
    sub.connect(v.sub).connect(centre);

    const noise = new AudioBufferSourceNode(ctx, { buffer: noiseBuffer(ctx), loop: true });
    v.noise = new GainNode(ctx, { gain: p.noise });
    noise.connect(v.noise).connect(centre);

    // Drive, then one or two filter stages, then the amp.
    v.driveIn = new GainNode(ctx);
    v.driveOut = new GainNode(ctx);
    mix.connect(v.driveIn).connect(new WaveShaperNode(ctx, { curve: driveCurve(), oversample: '2x' })).connect(v.driveOut);
    this.#setDrive(v);
    const stages = p.slope === '24' ? 2 : 1;
    v.filters = Array.from({ length: stages }, () => new BiquadFilterNode(ctx, {
      type: p.filterType, frequency: p.cutoff * v.cutoffScale, Q: stageQ(p.filterType, p.resonance, stages),
    }));
    v.vca = new GainNode(ctx, { gain: 0 });
    v.filters.reduce((from, f) => from.connect(f), v.driveOut).connect(v.vca).connect(this.output);

    v.filterLfo = new GainNode(ctx, { gain: p.lfoMod * 1200 });
    v.lfoIn.connect(v.filterLfo);
    for (const f of v.filters) {
      v.filterLfo.connect(f.detune);
      envStart(f.detune, t, {
        attack: p.filterAttack, decay: p.filterDecay, sustain: p.filterSustain, peak: p.envMod * 1200 * touch,
      });
    }
    envStart(v.vca.gain, t, { attack: p.attack, decay: p.decay, sustain: p.sustain, peak: touch });

    for (const osc of v.pitched) {
      v.vibrato.connect(osc.detune);
      osc.start(t);
    }
    this.#setWidth(v);
    // A different stretch of the (seeded) noise per note, so voices don't sum coherently.
    noise.start(t, (note * 0.137) % 2);
    v.sources.push(noise);
    v.sources[0].onended = () => {
      this.lfo.disconnect(v.lfoIn);
      v.vca.disconnect();
      this.live.delete(v);
    };
    return v;
  }

  /** An oscillator on the note, detuned by `cents`, that the vibrato reaches. */
  #osc(v, type, cents) {
    const osc = new OscillatorNode(this.ctx, { type, frequency: v.hz, detune: cents });
    v.sources.push(osc);
    v.pitched.push(osc);
    return osc;
  }

  /**
   * A saw as is, or as a pulse: the saw minus a copy delayed by `width` of
   * a cycle. `which` names the oscillator, so its width can follow its tuning.
   */
  #shape(v, osc, pulse, which) {
    const out = new GainNode(this.ctx);
    osc.connect(out);
    if (pulse) {
      const delay = new DelayNode(this.ctx, { maxDelayTime: 1, delayTime: 0 });
      const pwm = new GainNode(this.ctx, { gain: 0 });
      osc.connect(delay).connect(new GainNode(this.ctx, { gain: -1 })).connect(out);
      v.lfoIn.connect(pwm).connect(delay.delayTime);
      v.pulses.push({ delay, pwm, which });
    }
    return out;
  }

  /**
   * The supersaw stack: the centre saw into oscillator 1's level like any
   * oscillator, and the six detuned saws as a stereo pair, spread and then
   * highpassed at LOW_FOCUS on the way into the mix.
   */
  #supersaw(v, mix) {
    const ctx = this.ctx;
    const waves = supersawWaves(ctx);
    v.saws = waves.map((periodicWave) => {
      const saw = new OscillatorNode(ctx, { periodicWave, frequency: v.hz });
      v.sources.push(saw);
      v.pitched.push(saw);
      return saw;
    });
    v.centreLevel = new GainNode(ctx);
    v.sideLevel = new GainNode(ctx);
    v.saws[CENTRE].connect(v.centreLevel).connect(v.osc1);

    const sides = [new GainNode(ctx), new GainNode(ctx)];
    v.saws.forEach((saw, i) => i !== CENTRE && saw.connect(sides[SAW_SIDES[i]]));
    const pair = new ChannelMergerNode(ctx, { numberOfInputs: 2 });
    // [to own side, to the other] for each side.
    v.pan = sides.map((side, s) => [s, 1 - s].map((channel) => {
      const gain = new GainNode(ctx);
      side.connect(gain).connect(pair, 0, channel);
      return gain;
    }));
    v.osc1Wide = new GainNode(ctx, { gain: this.params.osc1Level });
    pair
      .connect(v.sideLevel)
      .connect(new BiquadFilterNode(ctx, { type: 'highpass', frequency: LOW_FOCUS, Q: -3 }))
      .connect(v.osc1Wide)
      .connect(mix);
    this.#setStack(v);
  }

  /**
   * Detune, blend and spread on a supersaw voice. The blend gains are
   * scaled so each channel of the stack is as loud as one saw whatever the
   * blend: the saws are uncorrelated, so their powers add, and the spread
   * is equal-power, so each channel carries the centre saw and half the
   * six detuned ones' power. `time` undefined sets values directly.
   */
  #setStack(v, time) {
    if (!v.saws) return;
    const { detune, blend, spread } = this.params;
    const scale = detuneCurve(detune);
    v.saws.forEach((saw, i) => set(saw.detune, 1200 * Math.log2(1 + SAW_OFFSETS[i] * scale) + v.cents, time));
    const [centre, side] = blendGains(blend);
    const norm = 1 / Math.hypot(centre, side * Math.sqrt((SAW_OFFSETS.length - 1) / 2));
    set(v.centreLevel.gain, centre * norm, time);
    set(v.sideLevel.gain, side * norm, time);
    const angle = ((1 - spread) * Math.PI) / 4;
    for (const [own, other] of v.pan) {
      set(own.gain, Math.cos(angle), time);
      set(other.gain, Math.sin(angle), time);
    }
  }

  #osc2Cents(v) {
    return this.params.osc2Tune * 100 + this.params.osc2Detune + v.cents;
  }

  /**
   * Pulse width as the delay between the two saws: the base width, plus
   * half the PWM sweep, with the LFO swinging it the other half either way.
   * `time` undefined sets values directly.
   */
  #setWidth(v, time) {
    const { width, pwm } = this.params;
    const sweep = pwm * (MAX_WIDTH - width);
    for (const pulse of v.pulses) {
      const hz = pulse.which === 2 ? v.hz * 2 ** (this.params.osc2Tune / 12) : v.hz;
      set(pulse.delay.delayTime, (width + sweep / 2) / hz, time);
      set(pulse.pwm.gain, sweep / 2 / hz, time);
    }
  }

  /**
   * Drive into the tanh, and back out by 1/tanh(push): a full-scale peak
   * comes out at full scale whatever the drive, while everything below it
   * is pushed up into the curve. Near zero drive it's close to clean.
   */
  #setDrive(v, time) {
    const push = drivePush(this.params.drive);
    set(v.driveIn.gain, push / DRIVE_RANGE, time);
    set(v.driveOut.gain, 1 / Math.tanh(push), time);
  }

  #release(note, t, release) {
    const v = this.voices.get(note);
    if (!v) return;
    this.voices.delete(note);
    envRelease(v.vca.gain, t, release);
    for (const f of v.filters) envRelease(f.detune, t, this.params.filterRelease);
    // Silent for certain once the sources stop, so the voice's cleanup, which
    // runs whenever the browser gets to it, can't cut anything audible.
    const end = t + release * 2 + 0.05;
    v.vca.gain.setValueAtTime(0, end);
    for (const source of v.sources) source.stop(end);
  }

  applyParam(name, value, time) {
    const p = this.params;
    const each = (fn) => { for (const v of this.live) fn(v); };
    const glide = (param, target) => param.setTargetAtTime(target, time, SMOOTH);
    switch (name) {
      case 'cutoff': each((v) => v.filters.forEach((f) => glide(f.frequency, value * v.cutoffScale))); break;
      case 'resonance':
      case 'filterType':
        each((v) => v.filters.forEach((f) => {
          f.type = p.filterType;
          glide(f.Q, stageQ(p.filterType, p.resonance, v.filters.length));
        }));
        break;
      case 'osc1Level': each((v) => [v.osc1, v.osc1Wide].forEach((g) => g && glide(g.gain, value))); break;
      case 'osc2Level': each((v) => glide(v.osc2.gain, value)); break;
      case 'sub': each((v) => glide(v.sub.gain, value)); break;
      case 'noise': each((v) => glide(v.noise.gain, value)); break;
      case 'osc2Tune':
      case 'osc2Detune':
        each((v) => {
          glide(v.osc2Osc.detune, this.#osc2Cents(v));
          this.#setWidth(v, time);
        });
        break;
      case 'crossMod': each((v) => v.cross && glide(v.cross.gain, value * CROSS_MOD * v.hz)); break;
      case 'detune':
      case 'blend':
      case 'spread':
        each((v) => this.#setStack(v, time));
        break;
      case 'drive': each((v) => this.#setDrive(v, time)); break;
      case 'width':
      case 'pwm':
        each((v) => this.#setWidth(v, time));
        break;
      case 'vibrato': each((v) => glide(v.vibrato.gain, value)); break;
      case 'lfoMod': each((v) => glide(v.filterLfo.gain, value * 1200)); break;
      case 'lfoRate': glide(this.lfo.frequency, value); break;
      default: super.applyParam(name, value, time);
    }
  }

  dispose() {
    this.lfo.stop();
    super.dispose();
  }
}

/** Set a param now (`time` undefined), or glide it there from `time`. */
function set(param, value, time) {
  if (time == null) param.value = value;
  else param.setTargetAtTime(value, time, SMOOTH);
}
