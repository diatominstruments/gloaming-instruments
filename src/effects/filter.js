import { Effect, num, choice } from '../module.js';
import { SMOOTH } from '../util.js';

/** Filter — a single resonant biquad. Sweep `cutoff` from the sequencer for filter moves. */
export class Filter extends Effect {
  static id = 'filter';
  static label = 'Filter';
  static description = 'A single resonant filter. Sweep the cutoff for filter moves.';
  static tags = ['filter'];
  static params = {
    type: choice(['lowpass', 'highpass', 'bandpass', 'notch'], 'lowpass', {
      label: 'Type', description: 'Which part of the spectrum passes through.',
      labels: { lowpass: 'Low-pass', highpass: 'High-pass', bandpass: 'Band-pass', notch: 'Notch' },
    }),
    cutoff: num(20, 20000, 2000, {
      unit: 'Hz', scale: 'log', primary: true, label: 'Cutoff', description: 'Where the filter acts.',
    }),
    resonance: num(0, 20, 1, {
      primary: true, label: 'Resonance', description: 'Emphasis at the cutoff.',
    }),
  };
  static groups = [
    {
      id: 'filter', label: 'Filter', params: ['type', 'cutoff', 'resonance'],
      role: 'filter', bind: { type: 'type', cutoff: 'cutoff', resonance: 'resonance' },
    },
  ];
  static presets = {
    'Muffled': { type: 'lowpass', cutoff: 500, resonance: 0.5 },
    'Thin': { type: 'highpass', cutoff: 800, resonance: 1 },
    'Telephone': { type: 'bandpass', cutoff: 1500, resonance: 2 },
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
