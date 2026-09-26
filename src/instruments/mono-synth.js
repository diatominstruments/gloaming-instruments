import { Instrument, num, choice } from '../module.js';
import { mtof, envStart, envRelease, noiseBuffer, SMOOTH } from '../util.js';

// ---- warm character ----------------------------------------------------------

/** Curvature of the warm saw's ramp: 0 is a straight line. */
const SAW_CURVE = 2.5;
/** Soft-clip amount between the filter stages: higher saturates sooner. */
const DRIVE = 0.7;
/** Signal level the drive's curve spans (±), beyond which it hard-limits. */
const DRIVE_RANGE = 4;
/** Gain through the drive, making up what the steeper filter takes out. */
const WARM_MAKEUP = 1.3;
/** Cents of pitch drift per unit of the smoothed noise: ~2.5 ct RMS, ~7 ct peaks. */
const DRIFT_CENTS = 120;
/** Corner of the smoothing on the drift noise: it wanders about once a second. */
const DRIFT_RATE = 0.8;

const warmSaws = new WeakMap();

/**
 * A saw whose ramp bends like a capacitor charging, (1 - e^-kt) / (1 - e^-k),
 * instead of rising in a straight line. Its Fourier series has a closed
 * form, c_n = -1 / (k + 2πin), so the wave is built from that directly;
 * the browser band-limits it per note like any periodic wave.
 */
function warmSaw(ctx) {
  let wave = warmSaws.get(ctx);
  if (!wave) {
    const harmonics = 1024;
    const real = new Float32Array(harmonics);
    const imag = new Float32Array(harmonics);
    const k = SAW_CURVE;
    for (let n = 1; n < harmonics; n++) {
      const w = 2 * Math.PI * n;
      real[n] = (-2 * k) / (k * k + w * w);
      imag[n] = (-2 * w) / (k * k + w * w);
    }
    wave = new PeriodicWave(ctx, { real, imag });
    warmSaws.set(ctx, wave);
  }
  return wave;
}

/** tanh with WARM_MAKEUP gain for small signals, soft-limiting toward WARM_MAKEUP / DRIVE. */
function driveCurve() {
  const curve = new Float32Array(4096);
  for (let i = 0; i < curve.length; i++) {
    const x = (i / (curve.length - 1)) * 2 - 1;
    curve[i] = (Math.tanh(DRIVE * DRIVE_RANGE * x) / DRIVE) * WARM_MAKEUP;
  }
  return curve;
}

/**
 * MonoSynth — one oscillator plus a sub an octave down, through a resonant
 * lowpass with its own decay envelope. Acid basslines and leads.
 *
 * Monophonic with last-note priority: a note that arrives while another is
 * still held glides to the new pitch without retriggering the envelopes
 * (a 303-style slide). A sequencer gets a slide by sending the next noteOn
 * before the previous noteOff, and a plain retrigger by doing the opposite.
 *
 * The filter envelope rides on the biquad's `detune` (in cents), so the
 * `cutoff` knob and the envelope never fight over the same param.
 *
 * `character` switches between the clean graph and a warm one: the saw's
 * ramp bends slightly, the pitch drifts a few cents on seeded noise, and
 * the filter becomes two stages (24 dB/oct) with the resonance split
 * between them and a soft clipper in the middle, so resonant peaks round
 * off instead of whistling.
 */
export class MonoSynth extends Instrument {
  static id = 'mono-synth';
  static label = 'Mono Synth';
  static description = 'One oscillator plus a sub through a resonant lowpass. Acid basslines and leads; overlap notes to slide.';
  static tags = ['bass', 'lead'];
  static polyphony = 1;
  static params = {
    wave: choice(['sawtooth', 'square', 'triangle', 'sine'], 'sawtooth', {
      label: 'Wave', description: 'Shape of the main oscillator.',
      labels: { sawtooth: 'Saw', square: 'Square', triangle: 'Triangle', sine: 'Sine' },
    }),
    character: choice(['clean', 'warm'], 'clean', {
      label: 'Character',
      description: 'Warm curves the saw, lets the pitch drift, and makes the filter steeper with soft saturation.',
      labels: { clean: 'Clean', warm: 'Warm' },
    }),
    sub: num(0, 1, 0, {
      unit: '%', label: 'Sub', description: 'A square wave an octave below, for weight.',
    }),
    cutoff: num(30, 16000, 400, {
      unit: 'Hz', scale: 'log', primary: true,
      label: 'Cutoff', description: 'Filter frequency before the envelope opens it.',
    }),
    resonance: num(0, 25, 12, {
      unit: 'dB', primary: true,
      label: 'Resonance', description: 'Peak at the cutoff; high settings squelch.',
    }),
    envMod: num(0, 6, 3, {
      unit: 'oct', primary: true,
      label: 'Amount', description: 'How far above the cutoff each note opens the filter.',
    }),
    filterDecay: num(0.01, 2, 0.2, {
      unit: 's', scale: 'log', label: 'Decay', description: 'How quickly the filter closes again.',
    }),
    attack: num(0.001, 2, 0.003, {
      unit: 's', scale: 'log', label: 'Attack', description: 'Fade-in at the start of a note.',
    }),
    decay: num(0.01, 4, 0.3, {
      unit: 's', scale: 'log', label: 'Decay', description: 'Fall from the peak to the sustain level.',
    }),
    sustain: num(0, 1, 0.6, {
      unit: '%', label: 'Sustain', description: 'Level held while the note is held.',
    }),
    release: num(0.005, 4, 0.05, {
      unit: 's', scale: 'log', label: 'Release', description: 'Fade-out after the note ends.',
    }),
    glide: num(0, 1, 0.06, {
      unit: 's', label: 'Glide', description: 'Time to slide between overlapping notes.',
    }),
    gain: num(0, 1, 0.5, { unit: '%', label: 'Level', description: 'Output level.' }),
  };
  static groups = [
    { id: 'osc', label: 'Oscillator', params: ['wave', 'sub', 'character'] },
    {
      id: 'filter', label: 'Filter', params: ['cutoff', 'resonance'],
      role: 'filter', bind: { type: { value: 'lowpass' }, cutoff: 'cutoff', resonance: 'resonance' },
    },
    {
      id: 'filterEnv', label: 'Filter envelope', params: ['envMod', 'filterDecay'],
      role: 'envelope',
      bind: { attack: { value: 0.003 }, decay: 'filterDecay', sustain: { value: 0 }, amount: 'envMod' },
    },
    {
      id: 'amp', label: 'Amp envelope', params: ['attack', 'decay', 'sustain', 'release'],
      role: 'envelope', bind: { attack: 'attack', decay: 'decay', sustain: 'sustain', release: 'release' },
    },
    { id: 'play', label: 'Performance', params: ['glide', 'gain'] },
  ];
  static presets = {
    'Acid': { wave: 'sawtooth', cutoff: 300, resonance: 18, envMod: 3.5, filterDecay: 0.18 },
    'Sub bass': {
      wave: 'sine', sub: 0.6, cutoff: 200, resonance: 2, envMod: 0.5,
      attack: 0.005, decay: 0.5, sustain: 0.8, release: 0.1, glide: 0,
    },
    'Pluck': {
      wave: 'sawtooth', cutoff: 600, resonance: 8, envMod: 4, filterDecay: 0.12,
      decay: 0.25, sustain: 0, release: 0.15, glide: 0,
    },
    'Square lead': {
      wave: 'square', cutoff: 1800, resonance: 6, envMod: 1.5, filterDecay: 0.4,
      attack: 0.01, sustain: 0.8, release: 0.2, glide: 0.08, gain: 0.4,
    },
  };

  constructor(ctx, params) {
    super(ctx, params);
    const p = this.params;

    // One pitch source (in Hz) drives both oscillators; the sub rides it an
    // octave down via detune, so glide moves them together.
    this.pitch = new ConstantSourceNode(ctx, { offset: 440 });
    this.osc = new OscillatorNode(ctx, { type: p.wave, frequency: 0 });
    this.subOsc = new OscillatorNode(ctx, { type: 'square', frequency: 0, detune: -1200 });
    this.pitch.connect(this.osc.frequency);
    this.pitch.connect(this.subOsc.frequency);

    this.subLevel = new GainNode(ctx, { gain: p.sub });
    this.filter = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: p.cutoff });
    this.vca = new GainNode(ctx, { gain: 0 });

    this.osc.connect(this.filter);
    this.subOsc.connect(this.subLevel).connect(this.filter);
    this.vca.connect(this.output);

    // The warm path: drive and a second filter stage after the first, and
    // slow noise into both oscillators' detune. Wired in by #route.
    this.driveIn = new GainNode(ctx, { gain: 1 / DRIVE_RANGE });
    this.drive = new WaveShaperNode(ctx, { curve: driveCurve(), oversample: '4x' });
    this.filter2 = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: p.cutoff });
    this.driveIn.connect(this.drive).connect(this.filter2);
    this.driftNoise = new AudioBufferSourceNode(ctx, { buffer: noiseBuffer(ctx), loop: true, playbackRate: 0.05 });
    this.drift = new GainNode(ctx, { gain: DRIFT_CENTS });
    this.driftNoise
      .connect(new BiquadFilterNode(ctx, { type: 'lowpass', frequency: DRIFT_RATE, Q: 0 }))
      .connect(new BiquadFilterNode(ctx, { type: 'lowpass', frequency: DRIFT_RATE, Q: 0 }))
      .connect(this.drift);
    this.#route();

    for (const node of [this.pitch, this.osc, this.subOsc, this.driftNoise]) node.start();
    this.held = [];   // held notes, most recent last
  }

  get #warm() {
    return this.params.character === 'warm';
  }

  /** Wire the clean or warm graph for the current `character`. */
  #route() {
    const warm = this.#warm;
    this.filter.disconnect();
    this.drift.disconnect();
    this.filter2.disconnect();
    if (warm) {
      this.filter.connect(this.driveIn);
      this.filter2.connect(this.vca);
      this.drift.connect(this.osc.detune);
      this.drift.connect(this.subOsc.detune);
    } else {
      this.filter.connect(this.vca);
    }
    this.#setWave(this.params.wave);
    // Two stages in series add their peaks in dB, so each takes half.
    const q = warm ? this.params.resonance / 2 : this.params.resonance;
    for (const f of this.#filters) f.Q.value = q;
  }

  get #filters() {
    return this.#warm ? [this.filter, this.filter2] : [this.filter];
  }

  #setWave(wave) {
    if (wave === 'sawtooth' && this.#warm) this.osc.setPeriodicWave(warmSaw(this.ctx));
    else this.osc.type = wave;
  }

  noteOn(note, velocity = 1, time) {
    const t = this.at(time);
    const legato = this.held.length > 0;
    this.held = this.held.filter((n) => n !== note);
    this.held.push(note);

    this.#pitchTo(note, t, legato);
    if (legato) return;

    const p = this.params;
    envStart(this.vca.gain, t, { attack: p.attack, decay: p.decay, sustain: p.sustain, peak: velocity });
    for (const f of this.#filters) {
      envStart(f.detune, t, {
        attack: 0.003, decay: p.filterDecay, sustain: 0, peak: p.envMod * 1200 * velocity,
      });
    }
  }

  noteOff(note, time) {
    const i = this.held.indexOf(note);
    if (i < 0) return;
    const wasSounding = i === this.held.length - 1;
    this.held.splice(i, 1);
    if (!wasSounding) return;

    const t = this.at(time);
    if (this.held.length) this.#pitchTo(this.held.at(-1), t, true);
    else envRelease(this.vca.gain, t, this.params.release);
  }

  allNotesOff(time) {
    this.held = [];
    envRelease(this.vca.gain, this.at(time), 0.005);
  }

  #pitchTo(note, t, legato) {
    const hz = mtof(note);
    const offset = this.pitch.offset;
    offset.cancelScheduledValues(t);
    if (legato && this.params.glide > 0) offset.setTargetAtTime(hz, t, this.params.glide / 3);
    else offset.setValueAtTime(hz, t);
  }

  applyParam(name, value, time) {
    switch (name) {
      case 'wave': this.#setWave(value); break;
      case 'character': this.#route(); break;
      case 'sub': this.subLevel.gain.setTargetAtTime(value, time, SMOOTH); break;
      case 'cutoff':
        for (const f of [this.filter, this.filter2]) f.frequency.setTargetAtTime(value, time, SMOOTH);
        break;
      case 'resonance':
        for (const f of this.#filters) f.Q.setTargetAtTime(this.#warm ? value / 2 : value, time, SMOOTH);
        break;
      default: super.applyParam(name, value, time);
    }
  }

  dispose() {
    for (const node of [this.pitch, this.osc, this.subOsc, this.driftNoise]) node.stop();
    super.dispose();
  }
}
