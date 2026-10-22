import { Instrument, num, choice } from '../module.js';
import { mtof, envStart, envRelease } from '../util.js';
import { CHORDS } from '../effects/resonator.js';

const MAX_VOICES = 8;
/** In mono mode the one voice is kept under this key instead of its note. */
const MONO = 'mono';
/** Every wave is scaled to this RMS, so switching wave doesn't jump in loudness. */
const LEVEL = 0.35;
/** Harmonics in the waves' Fourier series; the browser band-limits them per note. */
const HARMONICS = 1024;
/** Long-mode noise is clocked at this multiple of the note's frequency, so higher notes hiss brighter. */
const NOISE_CLOCK = 32;
/**
 * Each shift-register step is held for this many samples in its buffer.
 * The buffer is played back resampled, which interpolates between samples;
 * with each step held, that only softens the edges, and the noise keeps
 * the hard steps of the hardware's sample-and-hold.
 */
const NOISE_HOLD = 8;
/** Arpeggio buffers hold each step for this many samples, played at a rate that makes it one step. */
const ARP_STEP = 1024;

// ---- waves -------------------------------------------------------------------

/**
 * The waves, each one cycle as a list of equal-length steps: the pulse
 * channels' three duty cycles (1/8, 1/4, 1/2), and the triangle channel's
 * 32-step, 4-bit ramp, whose stairs are what make it buzz.
 */
const TRIANGLE = [...Array(16).keys()].reverse().concat([...Array(16).keys()]);
const STEPS = {
  pulse12: [1, 0, 0, 0, 0, 0, 0, 0],
  pulse25: [1, 1, 0, 0, 0, 0, 0, 0],
  pulse50: [1, 1, 1, 1, 0, 0, 0, 0],
  triangle: TRIANGLE,
};

const waveCache = new WeakMap();

/**
 * A PeriodicWave for a cycle of equal steps. A step of height v from a to
 * b contributes v·(e^(−2πina) − e^(−2πinb)) / 2πin to harmonic n, so the
 * series is exact for any staircase. Scaled to RMS LEVEL with the DC left
 * out, and not normalized by the browser, so every wave is equally loud.
 */
function chipWave(ctx, wave) {
  let waves = waveCache.get(ctx);
  if (!waves) waveCache.set(ctx, (waves = new Map()));
  let periodic = waves.get(wave);
  if (!periodic) {
    const steps = STEPS[wave];
    const k = steps.length;
    const mean = steps.reduce((a, b) => a + b) / k;
    const std = Math.sqrt(steps.reduce((sum, v) => sum + (v - mean) ** 2, 0) / k);
    const real = new Float32Array(HARMONICS);
    const imag = new Float32Array(HARMONICS);
    for (let n = 1; n < HARMONICS; n++) {
      let re = 0;
      let im = 0;
      steps.forEach((v, j) => {
        // e^(−iθa) − e^(−iθb), divided by 2πin.
        const a = (2 * Math.PI * n * j) / k;
        const b = (2 * Math.PI * n * (j + 1)) / k;
        const dRe = Math.cos(a) - Math.cos(b);
        const dIm = -Math.sin(a) + Math.sin(b);
        re += (v * dIm) / (2 * Math.PI * n);
        im += (-v * dRe) / (2 * Math.PI * n);
      });
      // x(t) = Σ real·cos + imag·sin, from the complex coefficient c: 2·Re(c), −2·Im(c).
      real[n] = (2 * re * LEVEL) / std;
      imag[n] = (-2 * im * LEVEL) / std;
    }
    periodic = new PeriodicWave(ctx, { real, imag, disableNormalization: true });
    waves.set(wave, periodic);
  }
  return periodic;
}

// ---- noise -------------------------------------------------------------------

const lfsrCache = new WeakMap();

/**
 * The noise channel's 15-bit linear-feedback shift register, one sample
 * per clock, for one full period. Long mode feeds back bits 0 and 1 and
 * runs 32767 steps before repeating: hiss. Short mode feeds back bits 0
 * and 6 and repeats within a hundred steps, so it's heard as a buzzy,
 * metallic pitch. Deterministic by nature: the register always starts at 1.
 */
function lfsrBuffer(ctx, short) {
  let buffers = lfsrCache.get(ctx);
  if (!buffers) lfsrCache.set(ctx, (buffers = {}));
  const key = short ? 'short' : 'long';
  if (!buffers[key]) {
    const tap = short ? 6 : 1;
    const bits = [];
    let reg = 1;
    do {
      const feedback = (reg & 1) ^ ((reg >> tap) & 1);
      reg = (reg >> 1) | (feedback << 14);
      bits.push(reg & 1);
    } while (reg !== 1);
    const mean = bits.reduce((a, b) => a + b) / bits.length;
    const std = Math.sqrt(mean * (1 - mean)) || 1;
    const buffer = ctx.createBuffer(1, bits.length * NOISE_HOLD, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    bits.forEach((b, i) => data.fill(((b - mean) / std) * LEVEL, i * NOISE_HOLD, (i + 1) * NOISE_HOLD));
    buffers[key] = buffer;
  }
  return buffers[key];
}

// ---- arpeggio and volume steps -------------------------------------------------

const ARP_ORDERS = {
  up: (steps) => steps,
  down: (steps) => [...steps].reverse(),
  'up-down': (steps) => [...steps, ...steps.slice(1, -1).reverse()],
};
const arpCache = new WeakMap();

/** A loop of the chord's intervals in cents, one held step each, in the arpeggio's order. */
function arpBuffer(ctx, chord, order) {
  let buffers = arpCache.get(ctx);
  if (!buffers) arpCache.set(ctx, (buffers = new Map()));
  const key = `${chord}:${order}`;
  if (!buffers.has(key)) {
    const steps = ARP_ORDERS[order](CHORDS[chord].intervals);
    const buffer = ctx.createBuffer(1, steps.length * ARP_STEP, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    steps.forEach((interval, i) => data.fill(interval * 100, i * ARP_STEP, (i + 1) * ARP_STEP));
    buffers.set(key, buffer);
  }
  return buffers.get(key);
}

let volumeSteps = null;

/** The envelope, 0..1, rounded to the 16 levels of a 4-bit volume register. */
function volumeCurve() {
  if (!volumeSteps) {
    volumeSteps = new Float32Array(2049);
    for (let i = 0; i < volumeSteps.length; i++) {
      const u = (i / (volumeSteps.length - 1)) * 2 - 1;
      volumeSteps[i] = u <= 0 ? 0 : Math.round(u * 15) / 15;
    }
  }
  return volumeSteps;
}

const ARPS = Object.keys(CHORDS).filter((key) => key !== 'unison');

/**
 * ChipSynth — the sound channels of an 8-bit games console: pulse waves at
 * the three classic duty cycles, the stepped 4-bit triangle, and the
 * shift-register noise in its hissing long mode and metallic short mode.
 * Every wave is built exactly (a Fourier series of its stairs, or the
 * register's own bit sequence), so it renders the same everywhere.
 *
 * The rest is how trackers played those channels:
 *
 *   arp      the fast chord: the pitch cycles through a chord's notes at
 *            `arpRate`, so one channel sounds like three. It's a looped
 *            buffer of intervals on the pitch, so it's sample-exact and
 *            restarts with each note
 *   sweep    each note starts `sweep` semitones away and slides to its
 *            pitch over `sweepTime`: lasers, kicks, power-ups
 *   vibrato  fades in over `vibratoDelay`, as a tracker's delayed vibrato
 *   steps    rounds the volume envelope to 16 levels, as the hardware's
 *            4-bit volume did, so decays fall in audible steps
 *
 * Poly gives each note its own channel; mono is one channel with
 * last-note priority, sliding between overlapping notes over `glide`
 * without restarting the envelope or the arpeggio.
 *
 * Every param is read at note-on, except `gain`.
 */
export class ChipSynth extends Instrument {
  static id = 'chip-synth';
  static label = 'Chip Synth';
  static description = '8-bit console channels: pulse, stepped triangle and shift-register noise, with fast arpeggios, pitch sweeps and stepped volume. Chiptune leads, bass, arps and drums.';
  static tags = ['lead', 'bass', 'pluck', 'percussion'];
  static polyphony = MAX_VOICES;
  static params = {
    wave: choice(['pulse12', 'pulse25', 'pulse50', 'triangle', 'noise', 'metal'], 'pulse25', {
      primary: true, label: 'Wave', description: 'The channel: a pulse at one of three widths, the stepped triangle, or noise.',
      labels: {
        pulse12: 'Pulse 12.5%', pulse25: 'Pulse 25%', pulse50: 'Pulse 50%',
        triangle: 'Triangle', noise: 'Noise', metal: 'Metal noise',
      },
    }),
    arp: choice(['off', ...ARPS], 'off', {
      primary: true, label: 'Arpeggio', description: 'Cycles the pitch rapidly through a chord, so one note sounds like several.',
      labels: { off: 'Off', ...Object.fromEntries(ARPS.map((key) => [key, CHORDS[key].label])) },
    }),
    arpOrder: choice(Object.keys(ARP_ORDERS), 'up', {
      label: 'Order', description: 'The order the arpeggio plays the chord in.',
      labels: { up: 'Up', down: 'Down', 'up-down': 'Up and down' },
    }),
    arpRate: num(4, 60, 30, {
      unit: 'Hz', label: 'Rate', description: 'Arpeggio steps per second; 50 or 60 is a console\'s frame rate.',
    }),
    sweep: num(-48, 48, 0, {
      unit: 'st', center: 0, label: 'Sweep', description: 'Where each note\'s pitch starts, before sliding to the note: above for lasers and kicks, below for power-ups.',
    }),
    sweepTime: num(0.01, 2, 0.1, {
      unit: 's', scale: 'log', label: 'Time', description: 'How long the sweep takes to reach the note.',
    }),
    vibrato: num(0, 100, 0, {
      unit: 'ct', label: 'Depth', description: 'How far the vibrato bends the pitch either way.',
    }),
    vibratoRate: num(1, 12, 6, {
      unit: 'Hz', label: 'Rate', description: 'Speed of the vibrato.',
    }),
    vibratoDelay: num(0, 2, 0.2, {
      unit: 's', label: 'Delay', description: 'Time for the vibrato to fade in on each note.',
    }),
    attack: num(0.001, 2, 0.001, {
      unit: 's', scale: 'log', label: 'Attack', description: 'Fade-in at the start of a note.',
    }),
    decay: num(0.01, 4, 0.4, {
      unit: 's', scale: 'log', primary: true, label: 'Decay', description: 'Fall from the peak to the sustain level.',
    }),
    sustain: num(0, 1, 0.6, {
      unit: '%', label: 'Sustain', description: 'Level held while the note is held.',
    }),
    release: num(0.005, 4, 0.08, {
      unit: 's', scale: 'log', label: 'Release', description: 'Fade-out after the note ends.',
    }),
    steps: choice(['4-bit', 'smooth'], '4-bit', {
      label: 'Volume', description: '4-bit rounds the envelope to 16 levels, so fades fall in steps like the hardware\'s; smooth doesn\'t.',
      labels: { '4-bit': '4-bit', smooth: 'Smooth' },
    }),
    mode: choice(['poly', 'mono'], 'poly', {
      label: 'Mode', description: 'Poly plays chords; Mono is one channel, sliding between overlapping notes.',
      labels: { poly: 'Poly', mono: 'Mono' },
    }),
    glide: num(0, 1, 0.05, {
      unit: 's', activeWhen: { mode: 'mono' }, label: 'Glide', description: 'Time to slide between overlapping notes.',
    }),
    gain: num(0, 1, 0.5, { unit: '%', label: 'Level', description: 'Output level.' }),
  };
  static groups = [
    { id: 'channel', label: 'Channel', params: ['wave'] },
    { id: 'arp', label: 'Arpeggio', params: ['arp', 'arpOrder', 'arpRate'] },
    { id: 'pitch', label: 'Pitch sweep', params: ['sweep', 'sweepTime'] },
    { id: 'vibrato', label: 'Vibrato', params: ['vibrato', 'vibratoRate', 'vibratoDelay'] },
    {
      id: 'amp', label: 'Volume envelope', params: ['attack', 'decay', 'sustain', 'release', 'steps'],
      role: 'envelope', bind: { attack: 'attack', decay: 'decay', sustain: 'sustain', release: 'release' },
    },
    { id: 'play', label: 'Performance', params: ['mode', 'glide', 'gain'] },
  ];
  static presets = {
    'Lead': { wave: 'pulse25', decay: 0.3, sustain: 0.7, release: 0.1, vibrato: 25, vibratoDelay: 0.25, mode: 'mono', glide: 0.04 },
    'Square bass': { wave: 'pulse50', decay: 0.2, sustain: 0.8, release: 0.05 },
    'Triangle bass': { wave: 'triangle', decay: 0.5, sustain: 1, release: 0.03, steps: 'smooth' },
    'Major arp': { wave: 'pulse12', arp: 'major', arpRate: 30, decay: 0.6, sustain: 0.5, release: 0.1 },
    'Minor arp': { wave: 'pulse25', arp: 'minor', arpOrder: 'up-down', arpRate: 25, decay: 0.8, sustain: 0.4 },
    'Kick': { wave: 'triangle', sweep: 30, sweepTime: 0.08, decay: 0.15, sustain: 0, release: 0.02 },
    'Snare': { wave: 'noise', decay: 0.15, sustain: 0, release: 0.02 },
    'Hat': { wave: 'noise', decay: 0.04, sustain: 0, release: 0.01 },
    'Laser': { wave: 'pulse12', sweep: 36, sweepTime: 0.25, decay: 0.3, sustain: 0, release: 0.02 },
    'Power-up': { wave: 'pulse25', sweep: -24, sweepTime: 0.3, arp: 'octave', arpRate: 40, decay: 0.5, sustain: 0.3 },
    'Metal hit': { wave: 'metal', decay: 0.25, sustain: 0, release: 0.02 },
  };

  constructor(ctx, params) {
    super(ctx, params);
    this.voices = new Map();   // note (or MONO) -> voice, in start order
    this.held = [];            // mono mode: held notes, most recent last
  }

  noteOn(note, velocity = 1, time) {
    const t = this.at(time);
    if (this.params.mode === 'mono') {
      const legato = this.held.length > 0 && this.voices.has(MONO);
      this.held = this.held.filter((n) => n !== note);
      this.held.push(note);
      if (legato) {
        this.#glide(note, t);
        return;
      }
      this.#release(MONO, t, 0.005);
      this.voices.set(MONO, this.#voice(note, velocity, t));
      return;
    }
    this.#release(note, t, 0.005);
    if (this.voices.size >= MAX_VOICES) this.#release(this.voices.keys().next().value, t, 0.005);
    this.voices.set(note, this.#voice(note, velocity, t));
  }

  noteOff(note, time) {
    const t = this.at(time);
    if (this.params.mode !== 'mono') {
      this.#release(note, t, this.params.release);
      return;
    }
    const i = this.held.indexOf(note);
    if (i < 0) return;
    const wasSounding = i === this.held.length - 1;
    this.held.splice(i, 1);
    if (!wasSounding) return;
    if (this.held.length) this.#glide(this.held.at(-1), t);
    else this.#release(MONO, t, this.params.release);
  }

  allNotesOff(time) {
    const t = this.at(time);
    this.held = [];
    for (const key of [...this.voices.keys()]) this.#release(key, t, 0.005);
  }

  /** Whether the wave is the noise channel, which plays a buffer rather than an oscillator. */
  get #noisy() {
    return this.params.wave === 'noise' || this.params.wave === 'metal';
  }

  /**
   * Where the pitch lives: an oscillator's frequency in Hz, or the noise
   * buffer's playback rate, NOISE_HOLD samples per clock. Short-mode noise
   * repeats every `period` clocks, so clocking it at the note's frequency ×
   * period puts its buzz on the note.
   */
  #pitch(voice, note) {
    if (!voice.noise) return mtof(note);
    const period = voice.source.buffer.length / NOISE_HOLD;
    const clock = mtof(note) * (voice.short ? period : NOISE_CLOCK);
    return (clock * NOISE_HOLD) / this.ctx.sampleRate;
  }

  #voice(note, velocity, t) {
    const ctx = this.ctx;
    const p = this.params;
    const voice = { noise: this.#noisy, short: p.wave === 'metal' };
    voice.source = voice.noise
      ? new AudioBufferSourceNode(ctx, { buffer: lfsrBuffer(ctx, voice.short), loop: true })
      : new OscillatorNode(ctx, { periodicWave: chipWave(ctx, p.wave) });
    voice.pitch = voice.noise ? voice.source.playbackRate : voice.source.frequency;
    voice.pitch.value = this.#pitch(voice, note);
    const sources = [voice.source];

    // Pitch: the sweep on detune itself, the arpeggio and vibrato added into it.
    const detune = voice.source.detune;
    if (p.sweep !== 0) {
      detune.setValueAtTime(p.sweep * 100, t);
      detune.linearRampToValueAtTime(0, t + p.sweepTime);
    }
    if (p.arp !== 'off') {
      const arp = new AudioBufferSourceNode(ctx, {
        buffer: arpBuffer(ctx, p.arp, p.arpOrder), loop: true, playbackRate: (p.arpRate * ARP_STEP) / ctx.sampleRate,
      });
      arp.connect(detune);
      sources.push(arp);
    }
    if (p.vibrato > 0) {
      const lfo = new OscillatorNode(ctx, { frequency: p.vibratoRate });
      const depth = new GainNode(ctx, { gain: 0 });
      depth.gain.setValueAtTime(0, t);
      depth.gain.linearRampToValueAtTime(p.vibrato, t + Math.max(p.vibratoDelay, 0.001));
      lfo.connect(depth).connect(detune);
      sources.push(lfo);
    }

    // Volume: the envelope as a signal, stepped or not, driving the amp.
    voice.env = new ConstantSourceNode(ctx, { offset: 0 });
    const amp = new GainNode(ctx, { gain: 0 });
    const shaped = p.steps === '4-bit' ? voice.env.connect(new WaveShaperNode(ctx, { curve: volumeCurve() })) : voice.env;
    shaped.connect(amp.gain);
    voice.source.connect(amp).connect(this.output);
    envStart(voice.env.offset, t, { attack: p.attack, decay: p.decay, sustain: p.sustain, peak: velocity });
    sources.push(voice.env);

    voice.sources = sources;
    voice.source.onended = () => amp.disconnect();
    for (const source of sources) source.start(t);
    return voice;
  }

  /** Mono mode: slide the sounding voice to `note`. */
  #glide(note, t) {
    const voice = this.voices.get(MONO);
    const target = this.#pitch(voice, note);
    const { glide } = this.params;
    voice.pitch.cancelScheduledValues(t);
    if (glide > 0) voice.pitch.setTargetAtTime(target, t, glide / 3);
    else voice.pitch.setValueAtTime(target, t);
  }

  #release(key, t, release) {
    const voice = this.voices.get(key);
    if (!voice) return;
    this.voices.delete(key);
    envRelease(voice.env.offset, t, release);
    const end = t + release * 2 + 0.05;
    for (const source of voice.sources) source.stop(end);
  }
}
