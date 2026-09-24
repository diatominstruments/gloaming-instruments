import { Effect, num, choice } from '../module.js';
import { SMOOTH } from '../util.js';

/** Filter — a single resonant biquad. Sweep `cutoff` from the sequencer for filter moves. */
export class Filter extends Effect {
  static id = 'filter';
  static params = {
    type:      choice(['lowpass', 'highpass', 'bandpass', 'notch'], 'lowpass'),
    cutoff:    num(20, 20000, 2000, { unit: 'Hz', scale: 'log' }),
    resonance: num(0, 20, 1),
  };

  constructor(ctx, params) {
    super(ctx, params);
    const p = this.params;
    this.filter = new BiquadFilterNode(ctx, { type: p.type, frequency: p.cutoff, Q: p.resonance });
    this.input.connect(this.filter).connect(this.output);
  }

  applyParam(name, value, time) {
    switch (name) {
      case 'type': this.filter.type = value; break;
      case 'cutoff': this.filter.frequency.setTargetAtTime(value, time, SMOOTH); break;
      case 'resonance': this.filter.Q.setTargetAtTime(value, time, SMOOTH); break;
    }
  }
}
