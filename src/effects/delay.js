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
  static params = {
    time:     num(0.01, 2, 0.36, { unit: 's' }),
    feedback: num(0, 0.95, 0.4),
    tone:     num(500, 16000, 3500, { unit: 'Hz', scale: 'log' }),
    mix:      num(0, 1, 0.3),
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
