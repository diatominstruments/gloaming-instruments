import { Effect, num } from '../module.js';
import { SMOOTH } from '../util.js';

/**
 * Delay — feedback echo with a lowpass in the loop, so each repeat is
 * darker than the last. `time` is in seconds; tempo sync is the song's job
 * (a dotted eighth at 125 BPM is 0.36 s). Changing `time` while echoes are
 * ringing bends their pitch, tape-style.
 */
export class Delay extends Effect {
  static id = 'delay';
  static label = 'Delay';
  static description = 'Feedback echo; each repeat is darker than the last.';
  static tags = ['time'];
  static params = {
    time: num(0.01, 2, 0.36, {
      unit: 's', primary: true, label: 'Time', description: 'Gap between repeats.',
    }),
    feedback: num(0, 0.95, 0.4, {
      unit: '%', primary: true, label: 'Feedback', description: 'How much of each repeat feeds the next.',
    }),
    tone: num(500, 16000, 3500, {
      unit: 'Hz', scale: 'log', label: 'Tone', description: 'Lowpass on the repeats; lower darkens them faster.',
    }),
    mix: num(0, 1, 0.3, {
      unit: '%', primary: true, label: 'Mix', description: 'Echoes against the dry signal.',
    }),
  };
  static groups = [
    { id: 'echo', label: 'Echo', params: ['time', 'feedback', 'tone'] },
    { id: 'output', label: 'Output', params: ['mix'] },
  ];
  static presets = {
    'Slapback': { time: 0.09, feedback: 0.1, tone: 6000, mix: 0.3 },
    'Dub': { time: 0.48, feedback: 0.7, tone: 1500, mix: 0.35 },
    'Ambient': { time: 0.75, feedback: 0.6, tone: 3000, mix: 0.25 },
  };

  constructor(ctx, params) {
    super(ctx, params);
    const p = this.params;
    this.dry = new GainNode(ctx, { gain: 1 - p.mix });
    this.wet = new GainNode(ctx, { gain: p.mix });
    this.delay = new DelayNode(ctx, { maxDelayTime: 2, delayTime: p.time });
    this.tone = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: p.tone });
    this.feedback = new GainNode(ctx, { gain: p.feedback });

    this.input.connect(this.dry).connect(this.output);
    this.input.connect(this.delay).connect(this.tone);
    this.tone.connect(this.feedback).connect(this.delay);
    this.tone.connect(this.wet).connect(this.output);
  }

  applyParam(name, value, time) {
    switch (name) {
      case 'time': this.delay.delayTime.setTargetAtTime(value, time, 0.05); break;
      case 'feedback': this.feedback.gain.setTargetAtTime(value, time, SMOOTH); break;
      case 'tone': this.tone.frequency.setTargetAtTime(value, time, SMOOTH); break;
      case 'mix':
        this.dry.gain.setTargetAtTime(1 - value, time, SMOOTH);
        this.wet.gain.setTargetAtTime(value, time, SMOOTH);
        break;
    }
  }
}
