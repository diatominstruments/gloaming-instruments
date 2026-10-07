import { Instrument, num, choice } from '../module.js';
import { mtof, envStart, envRelease, noiseBuffer, rng, SMOOTH } from '../util.js';

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

// ---- modulation --------------------------------------------------------------

/** Narrowest the pulse gets, as a share of the cycle, however far PWM pushes it. */
const MAX_WIDTH = 0.95;
/** Key tracking pivots on middle C: at 100%, the cutoff doubles per octave above it. */
const KEY_TRACK_ROOT = 60;
/** The LFO shapes an OscillatorNode makes; 'ramp' is its saw turned upside down. */
const LFO_TYPES = { triangle: 'triangle', square: 'square', ramp: 'sawtooth' };
/** Random LFO: this many held values, each this many samples long, looped. */
const LFO_STEPS = 64;
const LFO_STEP_LENGTH = 1024;
/**
 * Corner of the smoothing on the LFO's output. The square's and the random
 * LFO's instant jumps would otherwise snap the cutoff across octaves in a
 * sample, and the filter rings hard; this rounds them off in a few ms.
 */
const LFO_SMOOTH = 60;

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

const stepBuffers = new WeakMap();

/**
 * A loop of seeded random values held flat, for the sample-and-hold LFO.
 * Played at a rate where each step lasts one LFO cycle.
 */
function stepBuffer(ctx) {
  let buffer = stepBuffers.get(ctx);
  if (!buffer) {
    buffer = ctx.createBuffer(1, LFO_STEPS * LFO_STEP_LENGTH, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    const random = rng(0x5a4d);
    for (let i = 0; i < LFO_STEPS; i++) data.fill(random() * 2 - 1, i * LFO_STEP_LENGTH, (i + 1) * LFO_STEP_LENGTH);
    stepBuffers.set(ctx, buffer);
  }
  return buffer;
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
 * MonoSynth — two oscillators, a sub and noise through a resonant lowpass
 * with its own decay envelope, and an LFO for vibrato, wobble and PWM.
 * Acid basslines and leads.
 *
 * Monophonic with last-note priority: a note that arrives while another is
 * still held glides to the new pitch without retriggering the envelopes
 * (a 303-style slide). A sequencer gets a slide by sending the next noteOn
 * before the previous noteOff, and a plain retrigger by doing the opposite.
 *
 * The filter envelope rides on the biquad's `detune` (in cents), so the
 * `cutoff` knob and the envelope never fight over the same param. Key
 * tracking and the LFO add into the same `detune`, so all three stack.
 *
 * Everything that follows the pitch (key tracking, and the pulse width,
 * which is a delay of one period times the width) is scheduled alongside
 * it, so it glides with the note.
 *
 * `character` switches between the clean graph and a warm one: the saws'
 * ramps bend slightly, the pitch drifts a few cents on seeded noise, and
 * the filter becomes two stages (24 dB/oct) with the resonance split
 * between them and a soft clipper in the middle, so resonant peaks round
 * off instead of whistling.
 */
export class MonoSynth extends Instrument {
  static id = 'mono-synth';
  static label = 'Mono Synth';
  static description = 'Two oscillators, a sub and noise through a resonant lowpass, with an LFO for vibrato and wobble. Acid basslines and leads; overlap notes to slide.';
  static tags = ['bass', 'lead'];
  static polyphony = 1;
  static params = {
    wave: choice(['sawtooth', 'square', 'pulse', 'triangle', 'sine'], 'sawtooth', {
      label: 'Wave', description: 'Shape of the main oscillator.',
      labels: { sawtooth: 'Saw', square: 'Square', pulse: 'Pulse', triangle: 'Triangle', sine: 'Sine' },
    }),
    octave: choice(['-2', '-1', '0', '1', '2'], '0', {
      label: 'Octave', description: 'Transposes the whole synth.',
      labels: { '-2': '−2', '-1': '−1', '0': '0', '1': '+1', '2': '+2' },
    }),
    width: num(0.5, MAX_WIDTH, 0.5, {
      unit: '%', activeWhen: { wave: 'pulse' },
      label: 'Width', description: 'Pulse duty cycle: 50% is square, higher is thinner and nasal.',
    }),
    pwm: num(0, 1, 0, {
      unit: '%', activeWhen: { wave: 'pulse' },
      label: 'PWM', description: 'How far the LFO sweeps the pulse width toward its narrowest.',
    }),
    character: choice(['clean', 'warm'], 'clean', {
      label: 'Character',
      description: 'Warm curves the saws, lets the pitch drift, and makes the filter steeper with soft saturation.',
      labels: { clean: 'Clean', warm: 'Warm' },
    }),
    osc2Wave: choice(['sawtooth', 'square', 'triangle', 'sine'], 'sawtooth', {
      label: 'Wave', description: 'Shape of the second oscillator.',
      labels: { sawtooth: 'Saw', square: 'Square', triangle: 'Triangle', sine: 'Sine' },
    }),
    osc2Level: num(0, 1, 0, {
      unit: '%', label: 'Level', description: 'Level of the second oscillator; at 0 it is off.',
    }),
    osc2Tune: num(-24, 24, 0, {
      unit: 'st', center: 0,
      label: 'Tune', description: 'Pitch relative to the main oscillator: 7 is a fifth up, -12 an octave down.',
    }),
    osc2Detune: num(-50, 50, 7, {
      unit: 'ct', center: 0,
      label: 'Detune', description: 'Fine offset, so the two oscillators beat against each other.',
    }),
    sub: num(0, 1, 0, {
      unit: '%', label: 'Sub', description: 'A wave an octave or two below, for weight.',
    }),
    subWave: choice(['square', 'sine'], 'square', {
      label: 'Sub wave', description: 'Square is buzzy and present; sine is pure low end.',
      labels: { square: 'Square', sine: 'Sine' },
    }),
    subOctave: choice(['-1', '-2'], '-1', {
      label: 'Sub octave', description: 'How far below the main oscillator the sub sits.',
      labels: { '-1': '−1', '-2': '−2' },
    }),
    noise: num(0, 1, 0, {
      unit: '%', label: 'Noise', description: 'White noise into the filter, for breath and hiss.',
    }),
    cutoff: num(30, 16000, 400, {
      unit: 'Hz', scale: 'log', primary: true,
      label: 'Cutoff', description: 'Filter frequency before the envelope opens it.',
    }),
    resonance: num(0, 25, 12, {
      unit: 'dB', primary: true,
      label: 'Resonance', description: 'Peak at the cutoff; high settings squelch.',
    }),
    keyTrack: num(0, 1, 0, {
      unit: '%', label: 'Key track',
      description: 'How much the cutoff follows the note; at 100%, an octave up doubles it.',
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
    lfoWave: choice(['triangle', 'square', 'ramp', 'random'], 'triangle', {
      label: 'Wave', description: 'Shape of the LFO; random holds a new value each cycle (sample and hold).',
      labels: { triangle: 'Triangle', square: 'Square', ramp: 'Ramp down', random: 'Random' },
    }),
    lfoRate: num(0.1, 20, 4, {
      unit: 'Hz', scale: 'log', label: 'Rate', description: 'Speed of the LFO.',
    }),
    lfoSync: choice(['free', 'note'], 'note', {
      label: 'Sync',
      description: 'Free runs on regardless; Note restarts the LFO with each note that isn\'t slid into, so every note moves the same way.',
      labels: { free: 'Free', note: 'Note' },
    }),
    lfoDelay: num(0, 3, 0, {
      unit: 's', label: 'Delay', description: 'Time for the LFO to fade in on each note.',
    }),
    vibrato: num(0, 100, 0, {
      unit: 'ct', label: 'Vibrato', description: 'How far the LFO bends the pitch either way.',
    }),
    lfoMod: num(0, 4, 0, {
      unit: 'oct', label: 'Filter', description: 'How far the LFO sweeps the cutoff either way.',
    }),
    glide: num(0, 1, 0.06, {
      unit: 's', label: 'Glide', description: 'Time to slide between overlapping notes.',
    }),
    gain: num(0, 1, 0.5, { unit: '%', label: 'Level', description: 'Output level.' }),
  };
  static groups = [
    { id: 'osc', label: 'Oscillator', params: ['wave', 'octave', 'width', 'pwm', 'character'] },
    { id: 'osc2', label: 'Oscillator 2', params: ['osc2Wave', 'osc2Level', 'osc2Tune', 'osc2Detune'] },
    { id: 'mix', label: 'Sub and noise', params: ['sub', 'subWave', 'subOctave', 'noise'] },
    {
      id: 'filter', label: 'Filter', params: ['cutoff', 'resonance', 'keyTrack'],
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
    { id: 'lfo', label: 'LFO', params: ['lfoWave', 'lfoRate', 'lfoSync', 'lfoDelay', 'vibrato', 'lfoMod'] },
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
    'Wobble': {
      wave: 'sawtooth', character: 'warm', osc2Level: 0.7, osc2Detune: 12, sub: 0.6, subWave: 'sine',
      cutoff: 160, resonance: 12, keyTrack: 0.3, envMod: 0.5, sustain: 1, release: 0.08, glide: 0.04,
      lfoWave: 'triangle', lfoRate: 3, lfoMod: 2.5, gain: 0.4,
    },
    'Detuned lead': {
      wave: 'sawtooth', osc2Level: 0.8, osc2Detune: 14, cutoff: 1400, resonance: 5, keyTrack: 0.6,
      envMod: 1.5, filterDecay: 0.4, attack: 0.01, decay: 0.4, sustain: 0.8, release: 0.25, glide: 0.08,
      lfoRate: 5.5, lfoDelay: 0.35, vibrato: 18, gain: 0.35,
    },
    'PWM bass': {
      wave: 'pulse', width: 0.55, pwm: 0.6, sub: 0.5, cutoff: 450, resonance: 6, keyTrack: 0.3,
      envMod: 2, filterDecay: 0.25, decay: 0.4, sustain: 0.5, release: 0.08, glide: 0,
      lfoRate: 0.7, lfoSync: 'free',
    },
    'Fifths': {
      wave: 'square', osc2Wave: 'sawtooth', osc2Level: 0.6, osc2Tune: 7, osc2Detune: 3,
      cutoff: 900, resonance: 8, keyTrack: 0.5, envMod: 2.5, filterDecay: 0.3,
      decay: 0.3, sustain: 0.6, release: 0.15, gain: 0.4,
    },
    'Breath': {
      wave: 'triangle', noise: 0.25, cutoff: 1200, resonance: 4, keyTrack: 0.8, envMod: 1,
      attack: 0.08, sustain: 0.9, release: 0.3, glide: 0.1,
      lfoRate: 5, lfoDelay: 0.5, vibrato: 12, gain: 0.45,
    },
  };

  constructor(ctx, params) {
    super(ctx, params);
    const p = this.params;

    // One pitch source (in Hz) drives every oscillator; each sets its own
    // interval via detune, so glide moves them together.
    this.pitch = new ConstantSourceNode(ctx, { offset: 440 });
    this.osc = new OscillatorNode(ctx, { frequency: 0 });
    this.osc2 = new OscillatorNode(ctx, { frequency: 0, detune: p.osc2Tune * 100 + p.osc2Detune });
    this.subOsc = new OscillatorNode(ctx, { type: p.subWave, frequency: 0, detune: p.subOctave * 1200 });
    for (const osc of [this.osc, this.osc2, this.subOsc]) this.pitch.connect(osc.frequency);

    this.osc2Level = new GainNode(ctx, { gain: p.osc2Level });
    this.subLevel = new GainNode(ctx, { gain: p.sub });
    this.noise = new AudioBufferSourceNode(ctx, { buffer: noiseBuffer(ctx), loop: true });
    this.noiseLevel = new GainNode(ctx, { gain: p.noise });
    this.filter = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: p.cutoff });
    this.vca = new GainNode(ctx, { gain: 0 });

    this.osc.connect(this.filter);
    this.osc2.connect(this.osc2Level).connect(this.filter);
    this.subOsc.connect(this.subLevel).connect(this.filter);
    this.noise.connect(this.noiseLevel).connect(this.filter);
    this.vca.connect(this.output);

    // The pulse is the main oscillator's saw minus a copy delayed by `width`
    // of a cycle. When the wave isn't 'pulse', the copy is muted.
    this.pulseDelay = new DelayNode(ctx, { maxDelayTime: 1, delayTime: 0 });
    this.pulseInvert = new GainNode(ctx, { gain: 0 });
    this.osc.connect(this.pulseDelay).connect(this.pulseInvert).connect(this.filter);

    // The warm path: drive and a second filter stage after the first, and
    // slow noise into the oscillators' detune. Wired in by #route.
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

    // Key tracking, in cents, into both filter stages' detune.
    this.keyTrack = new ConstantSourceNode(ctx, { offset: 0 });
    for (const f of [this.filter, this.filter2]) this.keyTrack.connect(f.detune);

    // LFO source → sign (flips the ramp) → smoothing → per-note fade-in → each target.
    this.lfoSign = new GainNode(ctx, { gain: 1 });
    this.lfoFade = new GainNode(ctx, { gain: 1 });
    this.lfoSign
      .connect(new BiquadFilterNode(ctx, { type: 'lowpass', frequency: LFO_SMOOTH, Q: 0 }))
      .connect(this.lfoFade);
    this.vibrato = new GainNode(ctx, { gain: p.vibrato });
    this.lfoFade.connect(this.vibrato);
    for (const osc of [this.osc, this.osc2, this.subOsc]) this.vibrato.connect(osc.detune);
    this.filterLfo = new GainNode(ctx, { gain: p.lfoMod * 1200 });
    this.lfoFade.connect(this.filterLfo);
    for (const f of [this.filter, this.filter2]) this.filterLfo.connect(f.detune);
    this.pwm = new GainNode(ctx, { gain: 0 });
    this.lfoFade.connect(this.pwm).connect(this.pulseDelay.delayTime);

    this.#route();
    const t = ctx.currentTime;
    this.#startLfo(t);
    this.note = 69;   // the note the pitch is at (or heading to), before octave
    this.#track(t, 0);

    for (const node of [this.pitch, this.osc, this.osc2, this.subOsc, this.driftNoise, this.keyTrack]) node.start();
    this.noise.start(0, 1);   // a different stretch of the seeded noise from the drift's
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
      for (const osc of [this.osc, this.osc2, this.subOsc]) this.drift.connect(osc.detune);
    } else {
      this.filter.connect(this.vca);
    }
    this.#setWave(this.osc, this.params.wave);
    this.#setWave(this.osc2, this.params.osc2Wave);
    // Two stages in series add their peaks in dB, so each takes half.
    const q = warm ? this.params.resonance / 2 : this.params.resonance;
    for (const f of this.#filters) f.Q.value = q;
  }

  get #filters() {
    return this.#warm ? [this.filter, this.filter2] : [this.filter];
  }

  /** The pulse is built from the saw, so it gets the warm saw's curve too. */
  #setWave(osc, wave) {
    const pulse = wave === 'pulse';
    if (osc === this.osc) this.pulseInvert.gain.value = pulse ? -1 : 0;
    if (pulse) wave = 'sawtooth';
    if (wave === 'sawtooth' && this.#warm) osc.setPeriodicWave(warmSaw(this.ctx));
    else osc.type = wave;
  }

  /**
   * (Re)start the LFO from the top of its cycle at `t`, replacing the one
   * running. In 'free' sync this only happens when the wave changes.
   */
  #startLfo(t) {
    const { lfoWave, lfoRate } = this.params;
    const old = this.lfoSource;
    if (old) {
      old.onended = () => old.disconnect();
      old.stop(t);
    }
    const ctx = this.ctx;
    this.lfoSource = lfoWave === 'random'
      ? new AudioBufferSourceNode(ctx, { buffer: stepBuffer(ctx), loop: true, playbackRate: this.#stepRate(lfoRate) })
      : new OscillatorNode(ctx, { type: LFO_TYPES[lfoWave], frequency: lfoRate });
    this.lfoSign.gain.setValueAtTime(lfoWave === 'ramp' ? -1 : 1, t);
    this.lfoSource.connect(this.lfoSign);
    this.lfoSource.start(t);
  }

  /** Playback rate at which each of the random LFO's steps lasts one cycle. */
  #stepRate(hz) {
    return (hz * LFO_STEP_LENGTH) / this.ctx.sampleRate;
  }

  /**
   * Move everything that follows the pitch to the current note: the pitch,
   * key tracking, and the pulse's delay and PWM depth (both a share of the
   * period). A time constant of 0 jumps; otherwise each chases its target.
   */
  #track(t, tc) {
    const p = this.params;
    const note = this.note + 12 * Number(p.octave);
    const hz = mtof(note);
    const sweep = p.pwm * (MAX_WIDTH - p.width);
    const targets = [
      [this.pitch.offset, hz],
      [this.keyTrack.offset, p.keyTrack * (note - KEY_TRACK_ROOT) * 100],
      [this.pulseDelay.delayTime, (p.width + sweep / 2) / hz],
      [this.pwm.gain, sweep / 2 / hz],
    ];
    for (const [param, value] of targets) {
      param.cancelScheduledValues(t);
      if (tc > 0) param.setTargetAtTime(value, t, tc);
      else param.setValueAtTime(value, t);
    }
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
    if (p.lfoSync === 'note') this.#startLfo(t);
    if (p.lfoDelay > 0) {
      const fade = this.lfoFade.gain;
      fade.cancelScheduledValues(t);
      fade.setValueAtTime(0, t);
      fade.linearRampToValueAtTime(1, t + p.lfoDelay);
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
    this.note = note;
    this.#track(t, legato ? this.params.glide / 3 : 0);
  }

  applyParam(name, value, time) {
    switch (name) {
      case 'wave': this.#setWave(this.osc, value); break;
      case 'osc2Wave': this.#setWave(this.osc2, value); break;
      case 'character': this.#route(); break;
      case 'octave':
      case 'width':
      case 'pwm':
      case 'keyTrack':
        this.#track(time, SMOOTH);
        break;
      case 'osc2Level': this.osc2Level.gain.setTargetAtTime(value, time, SMOOTH); break;
      case 'osc2Tune':
      case 'osc2Detune':
        this.osc2.detune.setTargetAtTime(this.params.osc2Tune * 100 + this.params.osc2Detune, time, SMOOTH);
        break;
      case 'sub': this.subLevel.gain.setTargetAtTime(value, time, SMOOTH); break;
      case 'subWave': this.subOsc.type = value; break;
      case 'subOctave': this.subOsc.detune.setValueAtTime(value * 1200, time); break;
      case 'noise': this.noiseLevel.gain.setTargetAtTime(value, time, SMOOTH); break;
      case 'cutoff':
        for (const f of [this.filter, this.filter2]) f.frequency.setTargetAtTime(value, time, SMOOTH);
        break;
      case 'resonance':
        for (const f of this.#filters) f.Q.setTargetAtTime(this.#warm ? value / 2 : value, time, SMOOTH);
        break;
      case 'lfoWave': this.#startLfo(time); break;
      case 'lfoRate':
        if (this.lfoSource instanceof OscillatorNode) this.lfoSource.frequency.setTargetAtTime(value, time, SMOOTH);
        else this.lfoSource.playbackRate.setTargetAtTime(this.#stepRate(value), time, SMOOTH);
        break;
      case 'vibrato': this.vibrato.gain.setTargetAtTime(value, time, SMOOTH); break;
      case 'lfoMod': this.filterLfo.gain.setTargetAtTime(value * 1200, time, SMOOTH); break;
      default: super.applyParam(name, value, time);
    }
  }

  dispose() {
    for (const node of [this.pitch, this.osc, this.osc2, this.subOsc, this.noise, this.driftNoise, this.keyTrack, this.lfoSource]) {
      node.stop();
    }
    super.dispose();
  }
}
