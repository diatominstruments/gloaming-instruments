import { Effect, num, choice } from '../module.js';
import { SMOOTH } from '../util.js';

/** Top of `tone`, where the lowpass opens all the way. */
const TONE_OPEN = 20000;

/**
 * RingMod — the input multiplied by a carrier oscillator. A GainNode whose
 * gain is driven by the carrier from zero is an exact multiply, so every
 * frequency in the input splits into a pair at its sum and difference with
 * the carrier: bells, robots and metal from anything. Below about 20 Hz
 * the carrier is heard as a tremolo that flips polarity on every swing.
 *
 * Each side has its own carrier, `spread` cents apart, so the sidebands
 * beat differently left and right. An LFO sweeps both carriers' pitch,
 * `sweep` octaves either way, for the classic sci-fi warble. `tone` tames
 * the edge a square or saw carrier adds.
 */
export class RingMod extends Effect {
  static id = 'ring-mod';
  static label = 'Ring Mod';
  static description = 'Multiplies the input by an oscillator: clangorous bells, robot voices and metallic textures, or polarity-flipping tremolo at low rates.';
  static tags = ['modulation', 'distortion', 'character'];
  static params = {
    frequency: num(1, 5000, 440, {
      unit: 'Hz', scale: 'log', primary: true,
      label: 'Frequency', description: 'Pitch of the carrier. Low settings tremolo; high ones turn notes into clangour.',
    }),
    wave: choice(['sine', 'triangle', 'square', 'sawtooth'], 'sine', {
      label: 'Wave', description: 'Shape of the carrier: sine is cleanest, square and saw add more sidebands.',
      labels: { sine: 'Sine', triangle: 'Triangle', square: 'Square', sawtooth: 'Saw' },
    }),
    spread: num(0, 100, 0, {
      unit: 'ct', label: 'Spread', description: 'Detunes the left and right carriers apart, for movement across the field.',
    }),
    sweep: num(0, 3, 0, {
      unit: 'oct', primary: true, label: 'Sweep', description: 'How far the LFO moves the carrier\'s pitch either way.',
    }),
    sweepRate: num(0.05, 20, 0.5, {
      unit: 'Hz', scale: 'log', label: 'Rate', description: 'Speed of the LFO.',
    }),
    tone: num(500, TONE_OPEN, TONE_OPEN, {
      unit: 'Hz', scale: 'log', label: 'Tone', description: 'Lowpass on the modulated signal; all the way up is off.',
    }),
    mix: num(0, 1, 1, {
      unit: '%', primary: true, label: 'Mix', description: 'Modulated against the dry signal.',
    }),
  };
  static groups = [
    { id: 'carrier', label: 'Carrier', params: ['frequency', 'wave', 'spread'] },
    { id: 'lfo', label: 'LFO', params: ['sweep', 'sweepRate'] },
    { id: 'output', label: 'Output', params: ['tone', 'mix'] },
  ];
  static presets = {
    'Bell': { frequency: 620, wave: 'sine', mix: 0.6 },
    'Robot': { frequency: 90, wave: 'square', tone: 5000, mix: 0.9 },
    'Sci-fi': { frequency: 300, wave: 'sine', sweep: 1.5, sweepRate: 0.3, spread: 30, mix: 0.8 },
    'Choppy': { frequency: 8, wave: 'square', tone: 8000, mix: 1 },
    'Wide metal': { frequency: 1400, wave: 'triangle', spread: 60, tone: 9000, mix: 0.5 },
  };

  constructor(ctx, params) {
    super(ctx, params);
    const p = this.params;
    this.dry = new GainNode(ctx, { gain: 1 - p.mix });
    this.wet = new GainNode(ctx, { gain: p.mix });
    this.input.connect(this.dry).connect(this.output);

    const stereo = new GainNode(ctx, { channelCount: 2, channelCountMode: 'explicit', channelInterpretation: 'speakers' });
    const split = new ChannelSplitterNode(ctx, { numberOfOutputs: 2 });
    const merge = new ChannelMergerNode(ctx, { numberOfInputs: 2 });
    this.tone = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: this.#toneHz(p.tone), Q: -3 });
    this.input.connect(stereo).connect(split);
    merge.connect(this.tone).connect(this.wet).connect(this.output);

    this.lfo = new OscillatorNode(ctx, { frequency: p.sweepRate });
    this.sweep = new GainNode(ctx, { gain: p.sweep * 1200 });
    this.lfo.connect(this.sweep);

    // One multiplier per side: a gain resting at zero, driven by its carrier.
    this.carriers = [-1, 1].map((sign, side) => {
      const osc = new OscillatorNode(ctx, { type: p.wave, frequency: p.frequency, detune: (sign * p.spread) / 2 });
      const multiply = new GainNode(ctx, { gain: 0 });
      osc.connect(multiply.gain);
      this.sweep.connect(osc.detune);
      split.connect(multiply, side).connect(merge, 0, side);
      return { osc, sign };
    });
    const t = ctx.currentTime;
    for (const node of [this.lfo, ...this.carriers.map((c) => c.osc)]) node.start(t);
  }

  /** A lowpass at Nyquist passes everything untouched; one at 20 kHz would still shift phase. */
  #toneHz(value) {
    return value >= TONE_OPEN ? this.ctx.sampleRate / 2 : value;
  }

  applyParam(name, value, time) {
    switch (name) {
      case 'frequency':
        for (const { osc } of this.carriers) osc.frequency.setTargetAtTime(value, time, SMOOTH);
        break;
      case 'wave': for (const { osc } of this.carriers) osc.type = value; break;
      case 'spread':
        for (const { osc, sign } of this.carriers) osc.detune.setTargetAtTime((sign * value) / 2, time, SMOOTH);
        break;
      case 'sweep': this.sweep.gain.setTargetAtTime(value * 1200, time, SMOOTH); break;
      case 'sweepRate': this.lfo.frequency.setTargetAtTime(value, time, SMOOTH); break;
      case 'tone': this.tone.frequency.setTargetAtTime(this.#toneHz(value), time, SMOOTH); break;
      case 'mix':
        this.dry.gain.setTargetAtTime(1 - value, time, SMOOTH);
        this.wet.gain.setTargetAtTime(value, time, SMOOTH);
        break;
    }
  }

  dispose() {
    for (const node of [this.lfo, ...this.carriers.map((c) => c.osc)]) node.stop();
    super.dispose();
  }
}
