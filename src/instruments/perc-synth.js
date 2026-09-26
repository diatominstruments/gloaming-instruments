import { Instrument, num, choice } from '../module.js';
import { mtof, noiseBuffer, envStart, envRelease } from '../util.js';

const MAX_VOICES = 8;
const WAVES = ['sine', 'triangle', 'square', 'sawtooth'];
const WAVE_LABELS = { sine: 'Sine', triangle: 'Triangle', square: 'Square', sawtooth: 'Saw' };
/** Semitones of pitch swing at full LFO depth. */
const LFO_PITCH_RANGE = 24;

/**
 * PercSynth — two cross-modulating oscillators plus noise, for toms, zaps,
 * blips, metallic hits and other synthetic percussion.
 *
 * Each oscillator frequency-modulates the other, like patching two analog
 * VCOs' outputs into each other's linear FM inputs. Depth is an FM index:
 * the deviation is `index` × the modulating oscillator's frequency, so a
 * patch sounds the same across the keyboard. The loop runs through zero, so
 * heavy settings turn chaotic and noisy rather than just brighter.
 *
 * Web Audio mutes any cycle without a DelayNode in it, so the osc 2 → osc 1
 * path passes through one clamped to its minimum, a single render quantum
 * (128 samples, ~3 ms). That's inaudible as latency but, unlike real
 * hardware, it's still a delay in the loop, so extreme settings go chaotic
 * in their own way.
 *
 * Osc 1 has an ADSR pitch envelope, for the classic falling tom or rising
 * zap. The LFO restarts with every note, so repeated hits sound the same,
 * and can be sent to either oscillator's pitch or both, the cross-mod
 * depth, the noise level, or the amp.
 *
 * Every param is read at note-on (as on the FM synth), except `gain`.
 * Polyphonic: each note builds its own short-lived voice, and past
 * MAX_VOICES the oldest is stolen.
 */
export class PercSynth extends Instrument {
  static id = 'perc-synth';
  static label = 'Perc Synth';
  static description = 'Two cross-modulating oscillators plus noise, with a pitch envelope and an LFO. Toms, zaps and metallic hits.';
  static tags = ['percussion', 'drums'];
  static polyphony = MAX_VOICES;
  static gated = { mode: 'gate' };
  static params = {
    osc1Wave: choice(WAVES, 'sine', {
      label: 'Wave', description: 'Shape of oscillator 1.', labels: WAVE_LABELS,
    }),
    osc1Tune: num(-24, 24, 0, {
      unit: 'st', center: 0, label: 'Tune', description: 'Oscillator 1 pitch relative to the note.',
    }),
    osc1Level: num(0, 1, 1, {
      unit: '%', label: 'Level', description: 'How much of oscillator 1 you hear.',
    }),
    osc2Wave: choice(WAVES, 'sine', {
      label: 'Wave', description: 'Shape of oscillator 2.', labels: WAVE_LABELS,
    }),
    osc2Tune: num(-24, 24, 7, {
      unit: 'st', center: 0, label: 'Tune', description: 'Oscillator 2 pitch relative to the note.',
    }),
    osc2Level: num(0, 1, 0, {
      unit: '%', label: 'Level', description: 'How much of oscillator 2 you hear; it can modulate while silent.',
    }),
    mod1to2: num(0, 10, 0, {
      label: '1 → 2', description: 'How far oscillator 1 bends the frequency of oscillator 2.',
    }),
    mod2to1: num(0, 10, 1.5, {
      primary: true, label: '2 → 1', description: 'How far oscillator 2 bends the frequency of oscillator 1.',
    }),
    noise: num(0, 1, 0.15, {
      unit: '%', label: 'Level', description: 'White noise blended in with the oscillators.',
    }),
    noiseTone: num(200, 16000, 6000, {
      unit: 'Hz', scale: 'log', label: 'Tone', description: 'Lowpass on the noise: lower is darker.',
    }),
    pitchAmount: num(-48, 48, 24, {
      unit: 'st', center: 0, primary: true,
      label: 'Amount', description: 'How far the envelope moves oscillator 1: up, or down if negative.',
    }),
    pitchAttack: num(0.001, 2, 0.001, {
      unit: 's', scale: 'log', label: 'Attack', description: 'Time for the pitch to reach the full amount.',
    }),
    pitchDecay: num(0.005, 4, 0.08, {
      unit: 's', scale: 'log', label: 'Decay', description: 'Time for the pitch to fall to the sustain level.',
    }),
    pitchSustain: num(0, 1, 0, {
      unit: '%', label: 'Sustain', description: 'Share of the amount held after the decay.',
    }),
    pitchRelease: num(0.005, 4, 0.1, {
      unit: 's', scale: 'log', activeWhen: { mode: 'gate' },
      label: 'Release', description: 'Time for the pitch to return after the note ends.',
    }),
    mode: choice(['one-shot', 'gate'], 'one-shot', {
      label: 'Mode', description: 'One-shot decays to silence on its own; gated holds at the sustain level until note off.',
      labels: { 'one-shot': 'One-shot', gate: 'Gated' },
    }),
    attack: num(0.001, 2, 0.001, {
      unit: 's', scale: 'log', label: 'Attack', description: 'Fade-in at the start of a note.',
    }),
    decay: num(0.01, 4, 0.4, {
      unit: 's', scale: 'log', primary: true, label: 'Decay', description: 'Fall from the peak (to silence in one-shot mode).',
    }),
    sustain: num(0, 1, 0.5, {
      unit: '%', activeWhen: { mode: 'gate' }, label: 'Sustain', description: 'Level held while the note is held.',
    }),
    release: num(0.005, 4, 0.2, {
      unit: 's', scale: 'log', activeWhen: { mode: 'gate' },
      label: 'Release', description: 'Fade-out after the note ends.',
    }),
    lfoTarget: choice(['pitch', 'osc1', 'osc2', 'crossMod', 'noise', 'amp'], 'pitch', {
      label: 'Target', description: 'What the LFO moves.',
      labels: {
        pitch: 'Both pitches', osc1: 'Osc 1 pitch', osc2: 'Osc 2 pitch',
        crossMod: 'Cross-mod', noise: 'Noise level', amp: 'Amp',
      },
    }),
    lfoWave: choice(WAVES, 'triangle', {
      label: 'Wave', description: 'Shape of the LFO.', labels: WAVE_LABELS,
    }),
    lfoRate: num(0.1, 40, 6, {
      unit: 'Hz', scale: 'log', label: 'Rate', description: 'LFO speed; it restarts with every note.',
    }),
    lfoDepth: num(0, 1, 0, {
      unit: '%', label: 'Depth',
      description: `How far the LFO moves its target: up to ±${LFO_PITCH_RANGE} st of pitch, or the full range of a level.`,
    }),
    gain: num(0, 1, 0.5, { unit: '%', label: 'Level', description: 'Output level.' }),
  };
  static groups = [
    { id: 'osc1', label: 'Oscillator 1', params: ['osc1Wave', 'osc1Tune', 'osc1Level'] },
    { id: 'osc2', label: 'Oscillator 2', params: ['osc2Wave', 'osc2Tune', 'osc2Level'] },
    { id: 'crossMod', label: 'Cross-mod', params: ['mod1to2', 'mod2to1'] },
    { id: 'noise', label: 'Noise', params: ['noise', 'noiseTone'] },
    {
      id: 'pitchEnv', label: 'Pitch envelope',
      params: ['pitchAmount', 'pitchAttack', 'pitchDecay', 'pitchSustain', 'pitchRelease'],
      role: 'envelope',
      bind: {
        attack: 'pitchAttack', decay: 'pitchDecay', sustain: 'pitchSustain',
        release: 'pitchRelease', amount: 'pitchAmount',
      },
    },
    {
      id: 'amp', label: 'Amp envelope', params: ['mode', 'attack', 'decay', 'sustain', 'release'],
      role: 'envelope', bind: { attack: 'attack', decay: 'decay', sustain: 'sustain', release: 'release' },
    },
    { id: 'lfo', label: 'LFO', params: ['lfoTarget', 'lfoWave', 'lfoRate', 'lfoDepth'] },
    { id: 'output', label: 'Output', params: ['gain'] },
  ];
  static presets = {
    'Tom': {
      osc1Wave: 'sine', mod2to1: 0.3, osc2Tune: 7, noise: 0.08, noiseTone: 3000,
      pitchAmount: 12, pitchDecay: 0.12, decay: 0.45,
    },
    'Zap': {
      osc1Wave: 'sawtooth', mod2to1: 0, noise: 0, pitchAmount: 48, pitchDecay: 0.06, decay: 0.2,
    },
    'Metal': {
      osc1Wave: 'square', osc2Wave: 'square', osc2Tune: 11, osc2Level: 0.5,
      mod1to2: 3, mod2to1: 4, noise: 0.2, noiseTone: 12000, pitchAmount: 5, pitchDecay: 0.02, decay: 0.6,
    },
    'Chaos': {
      osc2Wave: 'triangle', osc2Tune: -5, mod1to2: 8, mod2to1: 8, noise: 0.1,
      pitchAmount: -12, pitchDecay: 0.5, decay: 0.8,
      lfoTarget: 'crossMod', lfoWave: 'square', lfoRate: 12, lfoDepth: 0.6,
    },
    'Blip': {
      osc1Wave: 'triangle', mod2to1: 0.8, osc2Tune: 12, noise: 0, pitchAmount: 7, pitchDecay: 0.01,
      decay: 0.08, lfoTarget: 'amp', lfoWave: 'square', lfoRate: 30, lfoDepth: 0.5,
    },
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

    const ctx = this.ctx;
    const hz1 = mtof(note + p.osc1Tune);
    const hz2 = mtof(note + p.osc2Tune);
    const osc1 = new OscillatorNode(ctx, { type: p.osc1Wave, frequency: hz1 });
    const osc2 = new OscillatorNode(ctx, { type: p.osc2Wave, frequency: hz2 });
    const noise = new AudioBufferSourceNode(ctx, { buffer: noiseBuffer(ctx), loop: true });

    // Cross-mod: each osc's output, scaled to an FM index, into the other's
    // frequency. The delay is what lets Web Audio run the loop at all.
    const depth1to2 = new GainNode(ctx, { gain: p.mod1to2 * hz1 });
    const depth2to1 = new GainNode(ctx, { gain: p.mod2to1 * hz2 });
    const loop = new DelayNode(ctx, { delayTime: 0 });
    osc1.connect(depth1to2).connect(osc2.frequency);
    osc2.connect(depth2to1).connect(loop).connect(osc1.frequency);

    const level1 = new GainNode(ctx, { gain: p.osc1Level });
    const level2 = new GainNode(ctx, { gain: p.osc2Level });
    const tone = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: p.noiseTone, Q: 0 });
    const noiseLevel = new GainNode(ctx, { gain: p.noise });
    const lfoAmp = new GainNode(ctx, { gain: 1 });
    const amp = new GainNode(ctx, { gain: 0 });
    osc1.connect(level1).connect(lfoAmp);
    osc2.connect(level2).connect(lfoAmp);
    noise.connect(tone).connect(noiseLevel).connect(lfoAmp);
    lfoAmp.connect(amp).connect(this.output);

    // The pitch envelope rides on detune (cents), leaving frequency free
    // for the cross-mod input.
    envStart(osc1.detune, t, {
      attack: p.pitchAttack, decay: p.pitchDecay, sustain: p.pitchSustain, peak: p.pitchAmount * 100,
    });

    const gated = p.mode === 'gate';
    envStart(amp.gain, t, {
      attack: p.attack, decay: p.decay, sustain: gated ? p.sustain : 0, peak: velocity,
    });

    const sources = [osc1, osc2, noise];
    const lfo = this.#lfo({ osc1, osc2, depth1to2, depth2to1, noiseLevel, lfoAmp });
    if (lfo) sources.push(lfo);

    // A one-shot stops itself once it has decayed ~50 dB (as envHit does);
    // a gated note runs until released.
    const end = gated ? Infinity : t + p.attack + p.decay * 2;
    const voice = { sources, amp, osc1, end };
    this.voices.set(note, voice);
    for (const source of sources) {
      source.start(t);
      if (!gated) source.stop(end);
    }
    osc1.onended = () => {
      amp.disconnect();
      if (this.voices.get(note) === voice) this.voices.delete(note);
    };
  }

  noteOff(note, time) {
    if (this.params.mode !== 'gate') return;
    const t = this.at(time);
    const voice = this.voices.get(note);
    if (voice) envRelease(voice.osc1.detune, t, this.params.pitchRelease);
    this.#release(note, t, this.params.release);
  }

  allNotesOff(time) {
    const t = this.at(time);
    for (const note of [...this.voices.keys()]) this.#release(note, t, 0.005);
  }

  /**
   * Connect a fresh LFO to whatever `lfoTarget` names, scaled by depth, and
   * return it for starting; null when depth is zero. Pitch targets move
   * detune; level targets swing around their set value, so full depth on a
   * level takes it from nothing to double.
   */
  #lfo({ osc1, osc2, depth1to2, depth2to1, noiseLevel, lfoAmp }) {
    const p = this.params;
    if (p.lfoDepth === 0) return null;
    const lfo = new OscillatorNode(this.ctx, { type: p.lfoWave, frequency: p.lfoRate });
    const send = (param, amount) => lfo.connect(new GainNode(this.ctx, { gain: amount })).connect(param);
    const cents = p.lfoDepth * LFO_PITCH_RANGE * 100;

    switch (p.lfoTarget) {
      case 'pitch': send(osc1.detune, cents); send(osc2.detune, cents); break;
      case 'osc1': send(osc1.detune, cents); break;
      case 'osc2': send(osc2.detune, cents); break;
      case 'crossMod':
        send(depth1to2.gain, depth1to2.gain.value * p.lfoDepth);
        send(depth2to1.gain, depth2to1.gain.value * p.lfoDepth);
        break;
      case 'noise': send(noiseLevel.gain, p.noise * p.lfoDepth); break;
      case 'amp':
        // Tremolo: dips from full level down to 1 - depth.
        lfoAmp.gain.value = 1 - p.lfoDepth / 2;
        send(lfoAmp.gain, p.lfoDepth / 2);
        break;
    }
    return lfo;
  }

  #release(note, t, release) {
    const voice = this.voices.get(note);
    if (!voice) return;
    this.voices.delete(note);
    envRelease(voice.amp.gain, t, release);
    // A later stop() replaces an earlier one, so never push a one-shot's back.
    const end = Math.min(t + release * 2 + 0.05, voice.end);
    for (const source of voice.sources) source.stop(end);
  }
}
