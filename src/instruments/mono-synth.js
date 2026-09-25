import { Instrument, num, choice } from '../module.js';
import { mtof, envStart, envRelease, SMOOTH } from '../util.js';

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
    { id: 'osc', label: 'Oscillator', params: ['wave', 'sub'] },
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
    this.filter = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: p.cutoff, Q: p.resonance });
    this.vca = new GainNode(ctx, { gain: 0 });

    this.osc.connect(this.filter);
    this.subOsc.connect(this.subLevel).connect(this.filter);
    this.filter.connect(this.vca).connect(this.output);

    for (const node of [this.pitch, this.osc, this.subOsc]) node.start();
    this.held = [];   // held notes, most recent last
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
    envStart(this.filter.detune, t, {
      attack: 0.003, decay: p.filterDecay, sustain: 0, peak: p.envMod * 1200 * velocity,
    });
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
      case 'wave': this.osc.type = value; break;
      case 'sub': this.subLevel.gain.setTargetAtTime(value, time, SMOOTH); break;
      case 'cutoff': this.filter.frequency.setTargetAtTime(value, time, SMOOTH); break;
      case 'resonance': this.filter.Q.setTargetAtTime(value, time, SMOOTH); break;
      default: super.applyParam(name, value, time);
    }
  }

  dispose() {
    for (const node of [this.pitch, this.osc, this.subOsc]) node.stop();
    super.dispose();
  }
}
