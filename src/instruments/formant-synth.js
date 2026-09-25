import { Instrument, num, choice } from '../module.js';
import { mtof, envStart, envRelease, SMOOTH } from '../util.js';

const MAX_VOICES = 8;
const VIBRATO_HZ = 5.5;

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

/**
 * FormantSynth — a choir of detuned sawtooths sung through four parallel
 * bandpass filters tuned to vowel formants. `vowel` runs continuously from
 * a (0) through e, i, o to u (4), interpolating the formants between them,
 * so sweeping it from the sequencer makes the synth talk.
 *
 * The filter bank is shared by every voice, like one throat singing a
 * chord, which keeps it cheap and makes the vowel a single knob.
 */
export class FormantSynth extends Instrument {
  static id = 'formant-synth';
  static params = {
    wave:    choice(['sawtooth', 'square'], 'sawtooth'),
    vowel:   num(0, 4, 0),
    width:   num(0.3, 3, 1),
    spread:  num(0, 50, 12, { unit: 'ct' }),
    vibrato: num(0, 100, 0, { unit: 'ct' }),
    attack:  num(0.001, 4, 0.08, { unit: 's', scale: 'log' }),
    decay:   num(0.01, 4, 0.5, { unit: 's', scale: 'log' }),
    sustain: num(0, 1, 0.7),
    release: num(0.005, 8, 0.4, { unit: 's', scale: 'log' }),
    gain:    num(0, 1, 0.5),
  };

  constructor(ctx, params) {
    super(ctx, params);
    const p = this.params;
    this.voices = new Map();   // note -> { oscs, amp }, in start order

    this.bank = new GainNode(ctx);
    this.formants = VOWELS[0].map(() => {
      const filter = new BiquadFilterNode(ctx, { type: 'bandpass' });
      const level = new GainNode(ctx);
      this.bank.connect(filter).connect(level).connect(this.output);
      return { filter, level };
    });
    this.#tune(p.vowel, p.width);

    this.lfo = new OscillatorNode(ctx, { frequency: VIBRATO_HZ });
    this.vibrato = new GainNode(ctx, { gain: p.vibrato });
    this.lfo.connect(this.vibrato);
    this.lfo.start();
  }

  noteOn(note, velocity = 1, time) {
    const t = this.at(time);
    const p = this.params;
    this.#release(note, t, 0.005);
    if (this.voices.size >= MAX_VOICES) this.#release(this.voices.keys().next().value, t, 0.005);

    const hz = mtof(note);
    const amp = new GainNode(this.ctx, { gain: 0 });
    amp.connect(this.bank);
    const oscs = [-0.5, 0.5].map((side) => {
      const osc = new OscillatorNode(this.ctx, { type: p.wave, frequency: hz, detune: side * p.spread });
      this.vibrato.connect(osc.detune);
      osc.connect(amp);
      return osc;
    });
    oscs[0].onended = () => {
      amp.disconnect();
      for (const osc of oscs) this.vibrato.disconnect(osc.detune);
    };

    envStart(amp.gain, t, { attack: p.attack, decay: p.decay, sustain: p.sustain, peak: velocity });
    for (const osc of oscs) osc.start(t);
    this.voices.set(note, { oscs, amp });
  }

  noteOff(note, time) {
    this.#release(note, this.at(time), this.params.release);
  }

  allNotesOff(time) {
    const t = this.at(time);
    for (const note of [...this.voices.keys()]) this.#release(note, t, 0.005);
  }

  #release(note, t, release) {
    const voice = this.voices.get(note);
    if (!voice) return;
    this.voices.delete(note);
    envRelease(voice.amp.gain, t, release);
    for (const osc of voice.oscs) osc.stop(t + release * 2 + 0.05);
  }

  // Interpolate between the two nearest vowels: frequencies geometrically,
  // levels in dB, bandwidths linearly. `time` undefined sets values directly.
  #tune(vowel, width, time) {
    const i = Math.min(Math.floor(vowel), VOWELS.length - 2);
    const x = vowel - i;
    const from = VOWELS[i];
    const to = VOWELS[i + 1];
    this.formants.forEach(({ filter, level }, k) => {
      const hz = from[k][0] * (to[k][0] / from[k][0]) ** x;
      const db = from[k][1] + (to[k][1] - from[k][1]) * x;
      const bw = (from[k][2] + (to[k][2] - from[k][2]) * x) * width;
      set(filter.frequency, hz, time);
      set(filter.Q, hz / bw, time);
      set(level.gain, 10 ** (db / 20), time);
    });
  }

  applyParam(name, value, time) {
    switch (name) {
      case 'wave':
        for (const { oscs } of this.voices.values()) for (const osc of oscs) osc.type = value;
        break;
      case 'vowel': this.#tune(value, this.params.width, time); break;
      case 'width': this.#tune(this.params.vowel, value, time); break;
      case 'vibrato': this.vibrato.gain.setTargetAtTime(value, time, SMOOTH); break;
      default: super.applyParam(name, value, time);
    }
  }

  dispose() {
    this.lfo.stop();
    super.dispose();
  }
}

function set(param, value, time) {
  if (time == null) param.value = value;
  else param.setTargetAtTime(value, time, SMOOTH);
}
