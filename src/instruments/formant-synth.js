import { Instrument, num, choice } from '../module.js';
import { mtof, envStart, envRelease, noiseBuffer, SMOOTH } from '../util.js';

const MAX_VOICES = 8;
const VIBRATO_HZ = 5.5;
/** Every formant filter sits here and reaches its frequency through `detune`. */
const BASE_HZ = 1000;
/** Points per vowel in the lookup curves from vowel position to formant settings. */
const STEPS_PER_VOWEL = 256;
/** Top of `tone`, where the lowpass opens all the way and leaves the voices untouched. */
const TONE_OPEN = 20000;
/** Noise gain at which a fully breathy note is about as loud as a toned one. */
const BREATH_LEVEL = 3.5;
/** In mono mode the one voice is kept under this key instead of its note. */
const MONO = 'mono';

/**
 * Formant tables for a, e, i, o, u: [centre Hz, level dB, bandwidth Hz] for
 * the first four formants of a tenor voice. The vowel is the shape of the
 * resonances, not the pitch, so one table serves every note.
 */
const VOWELS = [
  [[650, 0, 80], [1080, -6, 90], [2650, -7, 120], [2900, -8, 130]],     // a
  [[400, 0, 70], [1700, -14, 80], [2600, -12, 100], [3200, -14, 120]],  // e
  [[290, 0, 40], [1870, -15, 90], [2800, -18, 100], [3250, -20, 120]],  // i
  [[400, 0, 40], [800, -10, 80], [2600, -12, 100], [2800, -12, 120]],   // o
  [[350, 0, 40], [600, -20, 60], [2700, -17, 100], [2900, -14, 120]],   // u
];
/** The middle of the vowel range; the vowel signal is measured from here. */
const VOWEL_MID = (VOWELS.length - 1) / 2;

/**
 * Formant `k` partway between two vowels: frequency interpolated
 * geometrically, level in dB, bandwidth linearly. Returns [Hz, dB, bandwidth].
 */
function formantAt(vowel, k) {
  const i = Math.min(Math.floor(vowel), VOWELS.length - 2);
  const x = vowel - i;
  const [hz0, db0, bw0] = VOWELS[i][k];
  const [hz1, db1, bw1] = VOWELS[i + 1][k];
  return [hz0 * (hz1 / hz0) ** x, db0 + (db1 - db0) * x, bw0 + (bw1 - bw0) * x];
}

let curves = null;

/**
 * For each formant, WaveShaper curves from vowel position (a..u spread over
 * the shaper's -1..1 input) to its detune in cents from BASE_HZ, its Q at
 * width 1, and its linear level. Frequency is linear in cents between
 * vowels, so that curve is exact; the other two are smooth enough that
 * the shaper's linear interpolation between points is inaudible.
 */
function vowelCurves() {
  if (!curves) {
    const n = (VOWELS.length - 1) * STEPS_PER_VOWEL + 1;
    curves = VOWELS[0].map((_, k) => {
      const curve = { detune: new Float32Array(n), Q: new Float32Array(n), level: new Float32Array(n) };
      for (let j = 0; j < n; j++) {
        const [hz, db, bw] = formantAt(j / STEPS_PER_VOWEL, k);
        curve.detune[j] = 1200 * Math.log2(hz / BASE_HZ);
        curve.Q[j] = hz / bw;
        curve.level[j] = 10 ** (db / 20);
      }
      return curve;
    });
  }
  return curves;
}

/**
 * FormantSynth — a choir of detuned oscillators and breath noise sung
 * through four parallel bandpass filters tuned to vowel formants. `vowel`
 * runs continuously from a (0) through e, i, o to u (4), interpolating the
 * formants between them, so sweeping it makes the synth talk.
 *
 * The filter bank is shared by every voice, like one throat singing a
 * chord, which keeps it cheap and makes the vowel a single knob. The
 * vowel is an audio signal (the knob, plus each note's glide from
 * `vowelStart`, plus an LFO) that lookup curves turn into every formant's
 * frequency, width and level, so all three sources simply add. Because the
 * throat is shared, a new note restarts the vowel glide for notes already
 * sounding too; in mono mode, notes slid into don't restart it.
 *
 * Mono mode is last-note priority, as on the mono synth: a note arriving
 * while another is held glides to the new pitch without retriggering the
 * envelopes.
 */
export class FormantSynth extends Instrument {
  static id = 'formant-synth';
  static label = 'Formant Synth';
  static description = 'Detuned oscillators and breath sung through vowel formants, with a vowel glide and LFO to make it talk. Choirs, whispers and vocal leads.';
  static tags = ['voice', 'pad', 'lead'];
  static polyphony = MAX_VOICES;
  static params = {
    wave: choice(['sawtooth', 'square'], 'sawtooth', {
      label: 'Wave', description: 'Shape of the oscillators; square is hollower.',
      labels: { sawtooth: 'Saw', square: 'Square' },
    }),
    unison: choice(['1', '2', '3', '4', '5', '6'], '2', {
      label: 'Unison', description: 'Oscillators per note, fanned evenly across the spread.',
    }),
    spread: num(0, 50, 12, {
      unit: 'ct', primary: true, label: 'Spread', description: 'Detune between the outermost oscillators.',
    }),
    vibrato: num(0, 100, 0, {
      unit: 'ct', label: 'Vibrato', description: 'Depth of the pitch wobble.',
    }),
    breath: num(0, 1, 0, {
      unit: '%', label: 'Breath', description: 'Blends the oscillators into noise: a little is breathy, all the way is a whisper.',
    }),
    tone: num(200, TONE_OPEN, TONE_OPEN, {
      unit: 'Hz', scale: 'log',
      label: 'Tone', description: 'Lowpass on the voices before the formants: lower is darker and gentler; all the way up is off.',
    }),
    vowel: num(0, VOWELS.length - 1, 0, {
      primary: true, label: 'Vowel', description: 'Vowel shape, blending smoothly between neighbours.',
      marks: ['a', 'e', 'i', 'o', 'u'].map((label, value) => ({ value, label })),
    }),
    width: num(0.3, 3, 1, {
      unit: '×', label: 'Width', description: 'Formant bandwidth: narrow is sharper and more vocal, wide is softer.',
    }),
    shift: num(-12, 12, 0, {
      unit: 'st', center: 0,
      label: 'Shift', description: 'Moves every formant without changing the pitch: up is a smaller, younger throat, down a bigger one.',
    }),
    vowelStart: num(0, VOWELS.length - 1, 4, {
      label: 'Start', description: 'The vowel each note starts on before gliding along a-e-i-o-u to Vowel.',
      marks: ['a', 'e', 'i', 'o', 'u'].map((label, value) => ({ value, label })),
    }),
    vowelTime: num(0, 2, 0, {
      unit: 's', label: 'Time', description: 'How long each note takes to glide from Start to Vowel; 0 turns the glide off.',
    }),
    vowelLfoRate: num(0.05, 10, 0.5, {
      unit: 'Hz', scale: 'log', label: 'LFO rate', description: 'Speed of the vowel LFO.',
    }),
    vowelLfoDepth: num(0, 2, 0, {
      label: 'LFO depth', description: 'How many vowels the LFO sweeps either way of Vowel, stopping at a and u.',
    }),
    attack: num(0.001, 4, 0.08, {
      unit: 's', scale: 'log', label: 'Attack', description: 'Fade-in at the start of a note.',
    }),
    decay: num(0.01, 4, 0.5, {
      unit: 's', scale: 'log', label: 'Decay', description: 'Fall from the peak to the sustain level.',
    }),
    sustain: num(0, 1, 0.7, {
      unit: '%', label: 'Sustain', description: 'Level held while the note is held.',
    }),
    release: num(0.005, 8, 0.4, {
      unit: 's', scale: 'log', label: 'Release', description: 'Fade-out after the note ends.',
    }),
    mode: choice(['poly', 'mono'], 'poly', {
      label: 'Mode', description: 'Poly plays chords; Mono plays one note at a time, sliding between overlapping notes.',
      labels: { poly: 'Poly', mono: 'Mono' },
    }),
    glide: num(0, 1, 0.08, {
      unit: 's', activeWhen: { mode: 'mono' },
      label: 'Glide', description: 'Time to slide between overlapping notes.',
    }),
    gain: num(0, 1, 0.5, { unit: '%', label: 'Level', description: 'Output level.' }),
  };
  static groups = [
    { id: 'source', label: 'Source', params: ['wave', 'unison', 'spread', 'vibrato', 'breath', 'tone'] },
    { id: 'vowel', label: 'Vowel', params: ['vowel', 'width', 'shift'] },
    { id: 'motion', label: 'Vowel motion', params: ['vowelStart', 'vowelTime', 'vowelLfoRate', 'vowelLfoDepth'] },
    {
      id: 'amp', label: 'Amp envelope', params: ['attack', 'decay', 'sustain', 'release'],
      role: 'envelope', bind: { attack: 'attack', decay: 'decay', sustain: 'sustain', release: 'release' },
    },
    { id: 'play', label: 'Performance', params: ['mode', 'glide'] },
    { id: 'output', label: 'Output', params: ['gain'] },
  ];
  static presets = {
    'Choir': { vowel: 0, spread: 18, vibrato: 10, attack: 0.4, sustain: 0.8, release: 1.2 },
    'Talker': { vowel: 2, width: 0.6, spread: 6, attack: 0.01, sustain: 0.9, release: 0.1 },
    'Ooh pad': { vowel: 4, width: 1.5, spread: 25, vibrato: 6, attack: 1, sustain: 0.8, release: 2 },
    'Big choir': {
      unison: '6', spread: 35, vibrato: 12, breath: 0.15, tone: 5000, vowel: 0.5, shift: 3,
      vowelLfoRate: 0.15, vowelLfoDepth: 0.4, attack: 0.6, sustain: 0.85, release: 2, gain: 0.45,
    },
    'Yah lead': {
      mode: 'mono', glide: 0.07, unison: '2', spread: 8, vibrato: 15, vowel: 0, width: 0.7,
      vowelStart: 2, vowelTime: 0.2, attack: 0.01, sustain: 0.9, release: 0.15,
    },
    'Whisper': {
      breath: 0.9, vowel: 1, width: 1.2, vowelLfoRate: 0.3, vowelLfoDepth: 1,
      attack: 0.05, sustain: 0.8, release: 0.6,
    },
    'Yammer': {
      mode: 'mono', glide: 0.04, wave: 'square', unison: '1', vowel: 2, width: 0.6,
      vowelLfoRate: 6, vowelLfoDepth: 1.5, attack: 0.005, sustain: 1, release: 0.08, gain: 0.3,
    },
    'Giant': {
      unison: '3', spread: 20, tone: 2500, shift: -9, vowel: 3, vowelStart: 4, vowelTime: 0.6,
      vibrato: 8, attack: 0.2, sustain: 0.8, release: 0.8,
    },
  };

  constructor(ctx, params) {
    super(ctx, params);
    const p = this.params;
    this.voices = new Map();   // note (or MONO) -> voice, in start order
    this.held = [];            // mono mode: held notes, most recent last

    // Voices → tone and breath mixes → tone lowpass → formant bank.
    this.toneMix = new GainNode(ctx, { gain: 1 - p.breath });
    this.breathMix = new GainNode(ctx, { gain: p.breath * BREATH_LEVEL });
    this.tone = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: this.#toneHz(p.tone), Q: -3 });
    this.toneMix.connect(this.tone);
    this.breathMix.connect(this.tone);

    // The vowel as a signal, in vowels from the middle one: the knob, each
    // note's glide from Start, and the LFO, scaled so a..u spans -1..1.
    this.vowelIn = new GainNode(ctx, { gain: 1 / VOWEL_MID });
    this.vowel = new ConstantSourceNode(ctx, { offset: p.vowel - VOWEL_MID });
    this.vowelEnv = new ConstantSourceNode(ctx, { offset: 0 });
    this.vowelLfo = new OscillatorNode(ctx, { type: 'triangle', frequency: p.vowelLfoRate });
    this.vowelLfoDepth = new GainNode(ctx, { gain: p.vowelLfoDepth });
    this.vowel.connect(this.vowelIn);
    this.vowelEnv.connect(this.vowelIn);
    this.vowelLfo.connect(this.vowelLfoDepth).connect(this.vowelIn);
    this.shift = new ConstantSourceNode(ctx, { offset: p.shift * 100 });

    // Each formant's frequency, Q and level are looked up from the vowel
    // signal; the params' own values are zeroed so the lookups set them.
    this.widths = vowelCurves().map((curve) => {
      const filter = new BiquadFilterNode(ctx, { type: 'bandpass', frequency: BASE_HZ, Q: 0 });
      const level = new GainNode(ctx, { gain: 0 });
      const width = new GainNode(ctx, { gain: 1 / p.width });
      const lookup = (c) => this.vowelIn.connect(new WaveShaperNode(ctx, { curve: c }));
      lookup(curve.detune).connect(filter.detune);
      lookup(curve.Q).connect(width).connect(filter.Q);
      lookup(curve.level).connect(level.gain);
      this.shift.connect(filter.detune);
      this.tone.connect(filter).connect(level).connect(this.output);
      return width;
    });

    this.lfo = new OscillatorNode(ctx, { frequency: VIBRATO_HZ });
    this.vibrato = new GainNode(ctx, { gain: p.vibrato });
    this.lfo.connect(this.vibrato);
    for (const node of [this.lfo, this.vowel, this.vowelEnv, this.vowelLfo, this.shift]) node.start();
  }

  noteOn(note, velocity = 1, time) {
    const t = this.at(time);
    if (this.params.mode === 'mono') {
      const legato = this.held.length > 0;
      this.held = this.held.filter((n) => n !== note);
      this.held.push(note);
      if (legato) {
        this.#glide(note, t);
        return;
      }
      this.#release(MONO, t, 0.005);
      this.voices.set(MONO, this.#voice(note, velocity, t));
    } else {
      this.#release(note, t, 0.005);
      if (this.voices.size >= MAX_VOICES) this.#release(this.voices.keys().next().value, t, 0.005);
      this.voices.set(note, this.#voice(note, velocity, t));
    }
    this.#vowelGlide(t);
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

  /** One note's oscillators and breath, each through its own copy of the amp envelope. */
  #voice(note, velocity, t) {
    const ctx = this.ctx;
    const p = this.params;
    const hz = mtof(note);
    const count = Number(p.unison);
    const amp = new GainNode(ctx, { gain: 0 });
    const breath = new GainNode(ctx, { gain: 0 });
    amp.connect(this.toneMix);
    breath.connect(this.breathMix);

    // Fanned evenly across ±spread/2. Detuned oscillators add in power, so
    // each is scaled by √(2 / count): two, the original pair, stay at unity.
    const oscs = Array.from({ length: count }, (_, i) => {
      const side = count > 1 ? i / (count - 1) - 0.5 : 0;
      const osc = new OscillatorNode(ctx, { type: p.wave, frequency: hz, detune: side * p.spread });
      this.vibrato.connect(osc.detune);
      osc.connect(amp);
      return osc;
    });
    const noise = new AudioBufferSourceNode(ctx, { buffer: noiseBuffer(ctx), loop: true });
    noise.connect(breath);
    oscs[0].onended = () => {
      amp.disconnect();
      breath.disconnect();
      for (const osc of oscs) this.vibrato.disconnect(osc.detune);
    };

    const env = { attack: p.attack, decay: p.decay, sustain: p.sustain };
    envStart(amp.gain, t, { ...env, peak: velocity * Math.sqrt(2 / count) });
    envStart(breath.gain, t, { ...env, peak: velocity });
    for (const osc of oscs) osc.start(t);
    // A different stretch of the (seeded) noise per note, so voices don't sum coherently.
    noise.start(t, (note * 0.137) % 2);
    return { oscs, sources: [...oscs, noise], amps: [amp, breath] };
  }

  #release(key, t, release) {
    const voice = this.voices.get(key);
    if (!voice) return;
    this.voices.delete(key);
    for (const amp of voice.amps) envRelease(amp.gain, t, release);
    for (const source of voice.sources) source.stop(t + release * 2 + 0.05);
  }

  /** Mono mode: slide the sounding voice to `note`. */
  #glide(note, t) {
    const hz = mtof(note);
    const { glide } = this.params;
    for (const osc of this.voices.get(MONO).oscs) {
      osc.frequency.cancelScheduledValues(t);
      if (glide > 0) osc.frequency.setTargetAtTime(hz, t, glide / 3);
      else osc.frequency.setValueAtTime(hz, t);
    }
  }

  /**
   * A lowpass at Nyquist passes everything untouched, where one at 20 kHz
   * would still shift the formants' phase slightly; so the top of the
   * range is off.
   */
  #toneHz(value) {
    return value >= TONE_OPEN ? this.ctx.sampleRate / 2 : value;
  }

  /** Start the vowel at `vowelStart` and let it settle on `vowel`. */
  #vowelGlide(t) {
    const { vowel, vowelStart, vowelTime } = this.params;
    if (vowelTime <= 0) return;
    const offset = this.vowelEnv.offset;
    offset.cancelScheduledValues(t);
    offset.setValueAtTime(vowelStart - vowel, t);
    offset.setTargetAtTime(0, t, vowelTime / 3);
  }

  applyParam(name, value, time) {
    switch (name) {
      case 'wave':
        for (const { oscs } of this.voices.values()) for (const osc of oscs) osc.type = value;
        break;
      case 'vibrato': this.vibrato.gain.setTargetAtTime(value, time, SMOOTH); break;
      case 'breath':
        this.toneMix.gain.setTargetAtTime(1 - value, time, SMOOTH);
        this.breathMix.gain.setTargetAtTime(value * BREATH_LEVEL, time, SMOOTH);
        break;
      case 'tone': this.tone.frequency.setTargetAtTime(this.#toneHz(value), time, SMOOTH); break;
      case 'vowel': this.vowel.offset.setTargetAtTime(value - VOWEL_MID, time, SMOOTH); break;
      case 'width':
        for (const width of this.widths) width.gain.setTargetAtTime(1 / value, time, SMOOTH);
        break;
      case 'shift': this.shift.offset.setTargetAtTime(value * 100, time, SMOOTH); break;
      case 'vowelLfoRate': this.vowelLfo.frequency.setTargetAtTime(value, time, SMOOTH); break;
      case 'vowelLfoDepth': this.vowelLfoDepth.gain.setTargetAtTime(value, time, SMOOTH); break;
      case 'mode': this.allNotesOff(time); break;
      default: super.applyParam(name, value, time);
    }
  }

  dispose() {
    for (const node of [this.lfo, this.vowel, this.vowelEnv, this.vowelLfo, this.shift]) node.stop();
    super.dispose();
  }
}
