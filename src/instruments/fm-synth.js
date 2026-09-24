import { Instrument, num } from '../module.js';
import { mtof, envStart, envRelease } from '../util.js';

const MAX_VOICES = 8;

/**
 * FMSynth — two-operator FM, polyphonic. A modulator at `ratio` × the note
 * frequency bends the carrier's pitch; `index` sets how far, and the
 * modulator's own envelope lets the brightness decay separately from the
 * volume. Bells, electric pianos, metallic plucks.
 *
 * Each note builds its own short-lived oscillators, so voices cost nothing
 * while silent. Past MAX_VOICES the oldest voice is stolen.
 */
export class FMSynth extends Instrument {
  static id = 'fm-synth';
  static label = 'FM Synth';
  static params = {
    ratio:      num(0.5, 8, 3.5),
    index:      num(0, 20, 4),
    modDecay:   num(0.01, 4, 0.8, { unit: 's', scale: 'log' }),
    modSustain: num(0, 1, 0.1),
    attack:     num(0.001, 2, 0.002, { unit: 's', scale: 'log' }),
    decay:      num(0.01, 8, 1.5, { unit: 's', scale: 'log' }),
    sustain:    num(0, 1, 0),
    release:    num(0.005, 8, 0.8, { unit: 's', scale: 'log' }),
    gain:       num(0, 1, 0.3),
  };

  constructor(ctx, params) {
    super(ctx, params);
    this.voices = new Map();   // note -> voice, in start order
  }

  noteOn(note, velocity = 1, time) {
    const t = this.at(time);
    const p = this.params;
    this.#release(note, t, 0.005);
    if (this.voices.size >= MAX_VOICES) this.#release(this.voices.keys().next().value, t, 0.005);

    const hz = mtof(note);
    const modHz = hz * p.ratio;
    const carrier = new OscillatorNode(this.ctx, { frequency: hz });
    const modulator = new OscillatorNode(this.ctx, { frequency: modHz });
    const depth = new GainNode(this.ctx, { gain: 0 });
    const amp = new GainNode(this.ctx, { gain: 0 });

    modulator.connect(depth).connect(carrier.frequency);
    carrier.connect(amp).connect(this.output);
    carrier.onended = () => amp.disconnect();

    // Harder hits are brighter as well as louder.
    envStart(depth.gain, t, {
      attack: p.attack, decay: p.modDecay, sustain: p.modSustain, peak: p.index * modHz * velocity,
    });
    envStart(amp.gain, t, { attack: p.attack, decay: p.decay, sustain: p.sustain, peak: velocity });

    carrier.start(t);
    modulator.start(t);
    this.voices.set(note, { carrier, modulator, amp });
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
    const end = t + release * 2 + 0.05;
    voice.carrier.stop(end);
    voice.modulator.stop(end);
  }
}
