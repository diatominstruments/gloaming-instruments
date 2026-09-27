import { Effect, num } from '../module.js';
import { SMOOTH } from '../util.js';

/**
 * The three settings of the classic bucket-brigade polysynth chorus: I and
 * II are slow and deep, I+II is a fast, shallow shimmer. PolySynth's
 * `chorus` switch picks from these, and they're the Chorus presets too.
 */
export const CHORUS_MODES = Object.freeze({
  'I': { rate: 0.513, depth: 0.00185, delay: 0.0035 },
  'II': { rate: 0.863, depth: 0.00185, delay: 0.0035 },
  'I+II': { rate: 9.75, depth: 0.0002, delay: 0.0035 },
});

/**
 * Chorus — two short delay lines swept by one triangle LFO in opposite
 * directions, the left line on the LFO and the right on its inverse, so
 * while one side's pitch bends up the other bends down. That opposition is
 * where the width comes from. The input is summed to mono on the way into
 * the lines; the dry signal passes through untouched.
 *
 * The wet path is lowpassed at `tone`, like the dark, slightly lo-fi
 * output of a bucket-brigade delay chip.
 */
export class Chorus extends Effect {
  static id = 'chorus';
  static label = 'Chorus';
  static description = 'Stereo chorus: two delay lines swept in opposite directions. Widens pads, keys and strings.';
  static tags = ['modulation', 'space'];
  static params = {
    rate: num(0.05, 12, CHORUS_MODES.I.rate, {
      unit: 'Hz', scale: 'log', primary: true, label: 'Rate', description: 'Speed of the sweep.',
    }),
    depth: num(0, 0.005, CHORUS_MODES.I.depth, {
      unit: 's', primary: true, label: 'Depth', description: 'How far each delay line swings either side of its centre.',
    }),
    delay: num(0.001, 0.02, CHORUS_MODES.I.delay, {
      unit: 's', scale: 'log', label: 'Delay', description: 'Centre of the sweep; longer drifts toward doubling.',
    }),
    tone: num(1000, 16000, 9000, {
      unit: 'Hz', scale: 'log', label: 'Tone', description: 'Lowpass on the chorused signal.',
    }),
    mix: num(0, 1, 0.5, {
      unit: '%', primary: true, label: 'Mix', description: 'Chorused against the dry signal.',
    }),
  };
  static groups = [
    { id: 'sweep', label: 'Sweep', params: ['rate', 'depth', 'delay'] },
    { id: 'output', label: 'Output', params: ['tone', 'mix'] },
  ];
  static presets = {
    'Mode I': { ...CHORUS_MODES.I },
    'Mode II': { ...CHORUS_MODES.II },
    'Mode I+II': { ...CHORUS_MODES['I+II'] },
    'Slow and wide': { rate: 0.2, depth: 0.004, delay: 0.008, tone: 7000, mix: 0.5 },
  };

  constructor(ctx, params) {
    super(ctx, params);
    const p = this.params;
    this.dry = new GainNode(ctx, { gain: 1 - p.mix });
    this.wet = new GainNode(ctx, { gain: p.mix });
    this.input.connect(this.dry).connect(this.output);

    const mono = new GainNode(ctx, { channelCount: 1, channelCountMode: 'explicit', channelInterpretation: 'speakers' });
    this.tone = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: p.tone, Q: -3 });
    const merger = new ChannelMergerNode(ctx, { numberOfInputs: 2 });
    this.input.connect(mono).connect(this.tone);
    merger.connect(this.wet).connect(this.output);

    this.lfo = new OscillatorNode(ctx, { type: 'triangle', frequency: p.rate });
    // One swing gain per side, the right's negated, so they always oppose.
    this.lines = [1, -1].map((sign, side) => {
      const delay = new DelayNode(ctx, { maxDelayTime: 0.05, delayTime: p.delay });
      const swing = new GainNode(ctx, { gain: sign * p.depth });
      this.lfo.connect(swing).connect(delay.delayTime);
      this.tone.connect(delay).connect(merger, 0, side);
      return { delay, swing, sign };
    });
    this.lfo.start();
  }

  applyParam(name, value, time) {
    switch (name) {
      case 'rate': this.lfo.frequency.setTargetAtTime(value, time, SMOOTH); break;
      case 'depth':
        for (const line of this.lines) line.swing.gain.setTargetAtTime(line.sign * value, time, SMOOTH);
        break;
      case 'delay':
        for (const line of this.lines) line.delay.delayTime.setTargetAtTime(value, time, 0.05);
        break;
      case 'tone': this.tone.frequency.setTargetAtTime(value, time, SMOOTH); break;
      case 'mix':
        this.dry.gain.setTargetAtTime(1 - value, time, SMOOTH);
        this.wet.gain.setTargetAtTime(value, time, SMOOTH);
        break;
    }
  }

  dispose() {
    this.lfo.stop();
    super.dispose();
  }
}
