import { Instrument, num, choice } from '../module.js';
import { mtof, envStart, envRelease, noiseBuffer, SMOOTH } from '../util.js';
import { Chorus, CHORUS_MODES } from '../effects/chorus.js';

const MAX_VOICES = 6;
/** Narrowest the pulse gets, as a share of the cycle, however far PWM pushes it. */
const MAX_WIDTH = 0.95;
/** Key tracking pivots here: at 100%, the cutoff doubles per octave above middle C. */
const KEY_TRACK_ROOT = mtof(60);
/** Scales the summed oscillators so a full mix doesn't pile up past ±1. */
const MIX_LEVEL = 0.5;

/**
 * The switchable highpass after the voices are summed. `boost` is a low
 * shelf rather than a highpass, and `off` a shelf at 0 dB, so switching
 * only ever changes one filter's settings.
 */
const HPF = {
  boost: { type: 'lowshelf', frequency: 120, gain: 6 },
  off: { type: 'lowshelf', frequency: 120, gain: 0 },
  low: { type: 'highpass', frequency: 240, Q: -3 },
  high: { type: 'highpass', frequency: 720, Q: -3 },
};

/**
 * PolySynth — a six-voice analog-style polysynth in the classic 80s DCO
 * mould: one oscillator per voice mixing saw, pulse, a sub square an
 * octave down and noise, through a 24 dB resonant lowpass, then a
 * switchable highpass and a stereo chorus shared by every voice.
 *
 * The pulse is the voice's saw minus a delayed copy of itself; the delay,
 * as a share of the cycle, is the pulse width. Both saws are band-limited,
 * so the pulse is too, and sweeping the delay from the LFO is PWM.
 *
 * One ADSR shapes both the filter (through its `detune`, by `envMod`
 * octaves, which may be negative) and the amp, unless `vca` is 'gate'. One
 * triangle LFO runs for the whole instrument, so every voice moves
 * together; each note fades its share in over `lfoDelay`, then it bends
 * the pitch, the cutoff and the pulse width.
 *
 * The mixer levels, envelope and velocity are read at note-on. The filter,
 * LFO depths and pulse width also reach notes already sounding, so a
 * held chord can be swept. Past MAX_VOICES held notes, the oldest is
 * stolen; released notes ring out without counting.
 */
export class PolySynth extends Instrument {
  static id = 'poly-synth';
  static label = 'Poly Synth';
  static description = 'Six-voice analog-style polysynth: saw, pulse and sub through a resonant lowpass, with PWM and a lush stereo chorus. Pads, strings, brass and stabs.';
  static tags = ['pad', 'keys', 'bass'];
  static polyphony = MAX_VOICES;
  static params = {
    saw: num(0, 1, 1, { unit: '%', label: 'Saw', description: 'Level of the sawtooth.' }),
    pulse: num(0, 1, 0, { unit: '%', label: 'Pulse', description: 'Level of the pulse wave.' }),
    width: num(0.5, MAX_WIDTH, 0.5, {
      unit: '%', label: 'Width', description: 'Pulse duty cycle: 50% is square, higher is thinner and nasal.',
    }),
    pwm: num(0, 1, 0, {
      unit: '%', label: 'PWM', description: 'How far the LFO sweeps the pulse width toward its narrowest.',
    }),
    sub: num(0, 1, 0, { unit: '%', label: 'Sub', description: 'A square an octave below, for weight.' }),
    noise: num(0, 1, 0, { unit: '%', label: 'Noise', description: 'White noise, for breath and hiss.' }),
    cutoff: num(30, 16000, 2000, {
      unit: 'Hz', scale: 'log', primary: true,
      label: 'Cutoff', description: 'Lowpass frequency before the envelope and LFO move it.',
    }),
    resonance: num(0, 25, 4, {
      unit: 'dB', primary: true, label: 'Resonance', description: 'Peak at the cutoff.',
    }),
    envMod: num(-4, 6, 2, {
      unit: 'oct', center: 0, label: 'Env amount',
      description: 'How far the envelope moves the cutoff; negative closes it instead.',
    }),
    lfoMod: num(0, 3, 0, {
      unit: 'oct', label: 'LFO amount', description: 'How far the LFO sweeps the cutoff either way.',
    }),
    keyTrack: num(0, 1, 0.5, {
      unit: '%', label: 'Key track', description: 'How much the cutoff follows the note; at 100%, an octave up doubles it.',
    }),
    hpf: choice(Object.keys(HPF), 'off', {
      label: 'Highpass', description: 'Low end: boosted, flat, or thinned at about 240 Hz or 720 Hz.',
      labels: { boost: 'Bass boost', off: 'Off', low: '240 Hz', high: '720 Hz' },
    }),
    attack: num(0.001, 3, 0.005, {
      unit: 's', scale: 'log', label: 'Attack', description: 'Rise at the start of a note.',
    }),
    decay: num(0.01, 8, 0.5, {
      unit: 's', scale: 'log', label: 'Decay', description: 'Fall from the peak to the sustain level.',
    }),
    sustain: num(0, 1, 0.7, {
      unit: '%', label: 'Sustain', description: 'Level held while the note is held.',
    }),
    release: num(0.005, 8, 0.3, {
      unit: 's', scale: 'log', label: 'Release', description: 'Fade after the note ends.',
    }),
    vca: choice(['env', 'gate'], 'env', {
      label: 'Amp', description: 'Whether the envelope shapes the volume, or notes simply switch on and off.',
      labels: { env: 'Envelope', gate: 'Gate' },
    }),
    lfoRate: num(0.1, 20, 4, {
      unit: 'Hz', scale: 'log', label: 'Rate', description: 'Speed of the LFO.',
    }),
    lfoDelay: num(0, 3, 0, {
      unit: 's', label: 'Delay', description: 'Time for the LFO to fade in on each note.',
    }),
    vibrato: num(0, 100, 0, {
      unit: 'ct', label: 'Vibrato', description: 'How far the LFO bends the pitch either way.',
    }),
    chorus: choice(['off', ...Object.keys(CHORUS_MODES)], 'I', {
      primary: true, label: 'Chorus',
      description: 'The built-in stereo chorus: I and II are slow and deep, I+II fast and shimmering.',
      labels: { off: 'Off', 'I': 'I', 'II': 'II', 'I+II': 'I+II' },
    }),
    velocity: num(0, 1, 0, {
      unit: '%', label: 'Velocity',
      description: 'How much harder hits are louder and brighter; at 0 every note plays the same.',
    }),
    gain: num(0, 1, 0.35, { unit: '%', label: 'Level', description: 'Output level.' }),
  };
  static groups = [
    { id: 'osc', label: 'Oscillator', params: ['saw', 'pulse', 'width', 'pwm', 'sub', 'noise'] },
    {
      id: 'filter', label: 'Filter', params: ['cutoff', 'resonance', 'envMod', 'lfoMod', 'keyTrack'],
      role: 'filter', bind: { type: { value: 'lowpass' }, cutoff: 'cutoff', resonance: 'resonance' },
    },
    {
      id: 'env', label: 'Envelope', params: ['attack', 'decay', 'sustain', 'release', 'vca'],
      role: 'envelope', bind: { attack: 'attack', decay: 'decay', sustain: 'sustain', release: 'release' },
    },
    { id: 'lfo', label: 'LFO', params: ['lfoRate', 'lfoDelay', 'vibrato'] },
    { id: 'output', label: 'Output', params: ['hpf', 'chorus', 'velocity', 'gain'] },
  ];
  static presets = {
    'Pad': {
      saw: 1, pulse: 0.6, width: 0.6, pwm: 0.5, sub: 0.3, cutoff: 900, resonance: 3, envMod: 1.5, keyTrack: 0.5,
      attack: 0.6, decay: 2, sustain: 0.8, release: 1.5, lfoRate: 0.6, chorus: 'II', gain: 0.3,
    },
    'Strings': {
      saw: 1, pulse: 0, sub: 0, cutoff: 3500, resonance: 0, envMod: 0.5, keyTrack: 0.7, hpf: 'low',
      attack: 0.25, decay: 1, sustain: 0.9, release: 0.8, lfoRate: 5, lfoDelay: 0.6, vibrato: 12, chorus: 'I',
    },
    'Brass': {
      saw: 1, pulse: 0, sub: 0.2, cutoff: 500, resonance: 2, envMod: 3, keyTrack: 0.6,
      attack: 0.08, decay: 0.6, sustain: 0.6, release: 0.25, chorus: 'I', velocity: 0.4, gain: 0.5,
    },
    'Stab': {
      saw: 1, pulse: 0.5, width: 0.5, sub: 0.4, cutoff: 700, resonance: 8, envMod: 3.5,
      attack: 0.002, decay: 0.3, sustain: 0.2, release: 0.15, chorus: 'I+II',
    },
    'Square bass': {
      saw: 0, pulse: 1, width: 0.5, sub: 0.8, cutoff: 350, resonance: 6, envMod: 2.5, keyTrack: 0.3, hpf: 'boost',
      attack: 0.002, decay: 0.35, sustain: 0.5, release: 0.08, chorus: 'off', gain: 0.4,
    },
    'Pluck arp': {
      saw: 0.7, pulse: 0.7, width: 0.7, sub: 0, cutoff: 600, resonance: 10, envMod: 4, keyTrack: 0.8,
      attack: 0.001, decay: 0.25, sustain: 0, release: 0.25, chorus: 'II',
    },
    'Thin sweep': {
      saw: 0, pulse: 1, width: 0.75, pwm: 0.8, cutoff: 2500, resonance: 12, lfoMod: 1.2, envMod: 0,
      attack: 0.4, sustain: 1, release: 1.2, lfoRate: 0.25, hpf: 'high', chorus: 'I',
    },
  };

  constructor(ctx, params) {
    super(ctx, params);
    const p = this.params;
    this.voices = new Map();   // held note -> voice, in start order
    this.live = new Set();     // every voice still sounding, held or releasing

    this.lfo = new OscillatorNode(ctx, { type: 'triangle', frequency: p.lfoRate });
    this.lfo.start();

    // Voices → highpass → chorus → output.
    this.bus = new GainNode(ctx);
    this.hpf = new BiquadFilterNode(ctx, HPF[p.hpf]);
    this.chorus = new Chorus(ctx, this.#chorusParams(p.chorus));
    this.bus.connect(this.hpf).connect(this.chorus.input);
    this.chorus.output.connect(this.output);
  }

  noteOn(note, velocity = 1, time) {
    const t = this.at(time);
    const p = this.params;
    this.#release(note, t, 0.005);
    if (this.voices.size >= MAX_VOICES) this.#release(this.voices.keys().next().value, t, 0.005);

    const ctx = this.ctx;
    const hz = mtof(note);
    const touch = 1 - p.velocity * (1 - velocity);
    const sources = [];
    const mix = new GainNode(ctx, { gain: MIX_LEVEL });

    // One oscillator core: the saw, and the pulse made from it.
    const osc = new OscillatorNode(ctx, { type: 'sawtooth', frequency: hz });
    osc.start(t);
    sources.push(osc);
    if (p.saw > 0) osc.connect(new GainNode(ctx, { gain: p.saw })).connect(mix);
    let pulseDelay = null;
    if (p.pulse > 0) {
      const level = new GainNode(ctx, { gain: p.pulse });
      pulseDelay = new DelayNode(ctx, { maxDelayTime: 1 / hz, delayTime: 0 });
      osc.connect(level);
      osc.connect(pulseDelay).connect(new GainNode(ctx, { gain: -1 })).connect(level);
      level.connect(mix);
    }

    let sub = null;
    if (p.sub > 0) {
      sub = new OscillatorNode(ctx, { type: 'square', frequency: hz, detune: -1200 });
      sub.connect(new GainNode(ctx, { gain: p.sub })).connect(mix);
      sub.start(t);
      sources.push(sub);
    }
    if (p.noise > 0) {
      const noise = new AudioBufferSourceNode(ctx, { buffer: noiseBuffer(ctx), loop: true });
      noise.connect(new GainNode(ctx, { gain: p.noise })).connect(mix);
      // A different stretch of the (seeded) noise per note, so voices don't sum coherently.
      noise.start(t, (note * 0.137) % 2);
      sources.push(noise);
    }

    // Two 12 dB stages in series, each with half the resonance (their peaks add in dB).
    const keyScale = (hz / KEY_TRACK_ROOT) ** p.keyTrack;
    const filters = [0, 1].map(() => new BiquadFilterNode(ctx, {
      type: 'lowpass', frequency: p.cutoff * keyScale, Q: p.resonance / 2,
    }));
    const vca = new GainNode(ctx, { gain: 0 });
    mix.connect(filters[0]).connect(filters[1]).connect(vca).connect(this.bus);

    const env = { attack: p.attack, decay: p.decay, sustain: p.sustain };
    for (const f of filters) envStart(f.detune, t, { ...env, peak: p.envMod * 1200 * touch });
    if (p.vca === 'gate') envStart(vca.gain, t, { attack: 0.002, decay: 0.01, sustain: 1, peak: touch });
    else envStart(vca.gain, t, { ...env, peak: touch });

    // This voice's share of the LFO, faded in, then fanned out to its targets.
    const lfoIn = new GainNode(ctx, { gain: 0 });
    lfoIn.gain.setValueAtTime(0, t);
    lfoIn.gain.linearRampToValueAtTime(1, t + Math.max(p.lfoDelay, 0.001));
    this.lfo.connect(lfoIn);
    const vibrato = new GainNode(ctx, { gain: p.vibrato });
    lfoIn.connect(vibrato).connect(osc.detune);
    if (sub) vibrato.connect(sub.detune);
    const filterLfo = new GainNode(ctx, { gain: p.lfoMod * 1200 });
    lfoIn.connect(filterLfo);
    for (const f of filters) filterLfo.connect(f.detune);
    const pwm = new GainNode(ctx, { gain: 0 });
    if (pulseDelay) lfoIn.connect(pwm).connect(pulseDelay.delayTime);

    const voice = { hz, keyScale, sources, filters, vca, lfoIn, vibrato, filterLfo, pwm, pulseDelay };
    this.#setWidth(voice, t);
    osc.onended = () => {
      this.lfo.disconnect(lfoIn);
      vca.disconnect();
      this.live.delete(voice);
    };
    this.voices.set(note, voice);
    this.live.add(voice);
  }

  noteOff(note, time) {
    this.#release(note, this.at(time), this.params.vca === 'gate' ? 0.005 : this.params.release);
  }

  allNotesOff(time) {
    const t = this.at(time);
    for (const note of [...this.voices.keys()]) this.#release(note, t, 0.005);
  }

  #release(note, t, release) {
    const voice = this.voices.get(note);
    if (!voice) return;
    this.voices.delete(note);
    envRelease(voice.vca.gain, t, release);
    const end = t + release * 2 + 0.05;
    for (const source of voice.sources) source.stop(end);
  }

  /**
   * Pulse width as the delay between the two saws: the base width, plus
   * half the PWM sweep, with the LFO swinging it the other half either way.
   * The whole sweep fits between `width` and MAX_WIDTH.
   */
  #setWidth(voice, t) {
    if (!voice.pulseDelay) return;
    const { width, pwm } = this.params;
    const sweep = pwm * (MAX_WIDTH - width);
    voice.pulseDelay.delayTime.setTargetAtTime((width + sweep / 2) / voice.hz, t, SMOOTH);
    voice.pwm.gain.setTargetAtTime(sweep / 2 / voice.hz, t, SMOOTH);
  }

  #chorusParams(mode) {
    return mode === 'off' ? { mix: 0 } : { ...CHORUS_MODES[mode], mix: 0.5 };
  }

  applyParam(name, value, time) {
    switch (name) {
      case 'cutoff':
        for (const v of this.live) for (const f of v.filters) f.frequency.setTargetAtTime(value * v.keyScale, time, SMOOTH);
        break;
      case 'resonance':
        for (const v of this.live) for (const f of v.filters) f.Q.setTargetAtTime(value / 2, time, SMOOTH);
        break;
      case 'lfoMod':
        for (const v of this.live) v.filterLfo.gain.setTargetAtTime(value * 1200, time, SMOOTH);
        break;
      case 'vibrato':
        for (const v of this.live) v.vibrato.gain.setTargetAtTime(value, time, SMOOTH);
        break;
      case 'width':
      case 'pwm':
        for (const v of this.live) this.#setWidth(v, time);
        break;
      case 'lfoRate': this.lfo.frequency.setTargetAtTime(value, time, SMOOTH); break;
      case 'hpf': {
        const { type, frequency, gain = 0, Q = 1 } = HPF[value];
        this.hpf.type = type;
        this.hpf.frequency.setValueAtTime(frequency, time);
        this.hpf.gain.setValueAtTime(gain, time);
        this.hpf.Q.setValueAtTime(Q, time);
        break;
      }
      case 'chorus':
        for (const [param, v] of Object.entries(this.#chorusParams(value))) this.chorus.setParam(param, v, time);
        break;
      default: super.applyParam(name, value, time);
    }
  }

  dispose() {
    this.lfo.stop();
    this.chorus.dispose();
    super.dispose();
  }
}
