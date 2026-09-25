import { Effect, num, choice } from '../module.js';
import { SMOOTH } from '../util.js';

/**
 * AutoWah — a resonant filter that opens with the input's loudness. The
 * envelope follower is built from standard nodes: a WaveShaper rectifies
 * the signal (|x|, clamped at 1), a lowpass smooths it over `response`,
 * and the result drives the filter's `detune` in cents, `depth` octaves
 * above `cutoff` at full swing. Because the follower is part of the graph,
 * it renders offline like everything else.
 *
 * `sensitivity` is gain before the rectifier; past it the follower sits at
 * its ceiling, so a hot signal gives a wah that snaps fully open on every
 * hit and closes in the gaps.
 */
export class AutoWah extends Effect {
  static id = 'auto-wah';
  static params = {
    type:        choice(['lowpass', 'bandpass'], 'lowpass'),
    cutoff:      num(50, 5000, 250, { unit: 'Hz', scale: 'log' }),
    resonance:   num(0, 20, 8),
    depth:       num(0, 5, 3, { unit: 'oct' }),
    sensitivity: num(0, 40, 12, { unit: 'dB' }),
    response:    num(0.005, 0.5, 0.04, { unit: 's', scale: 'log' }),
    mix:         num(0, 1, 1),
  };

  constructor(ctx, params) {
    super(ctx, params);
    const p = this.params;
    this.dry = new GainNode(ctx, { gain: 1 - p.mix });
    this.wet = new GainNode(ctx, { gain: p.mix });
    this.filter = new BiquadFilterNode(ctx, { type: p.type, frequency: p.cutoff, Q: p.resonance });
    this.input.connect(this.dry).connect(this.output);
    this.input.connect(this.filter).connect(this.wet).connect(this.output);

    this.sens = new GainNode(ctx, { gain: 10 ** (p.sensitivity / 20) });
    this.rectifier = new WaveShaperNode(ctx, { curve: absCurve() });
    // Q of -6 dB makes the smoother critically damped: no overshoot past the ceiling.
    this.smooth = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: smoothHz(p.response), Q: -6 });
    this.depth = new GainNode(ctx, { gain: p.depth * 1200 });
    this.input.connect(this.sens).connect(this.rectifier).connect(this.smooth).connect(this.depth)
      .connect(this.filter.detune);
  }

  applyParam(name, value, time) {
    switch (name) {
      case 'type': this.filter.type = value; break;
      case 'cutoff': this.filter.frequency.setTargetAtTime(value, time, SMOOTH); break;
      case 'resonance': this.filter.Q.setTargetAtTime(value, time, SMOOTH); break;
      case 'depth': this.depth.gain.setTargetAtTime(value * 1200, time, SMOOTH); break;
      case 'sensitivity': this.sens.gain.setTargetAtTime(10 ** (value / 20), time, SMOOTH); break;
      case 'response': this.smooth.frequency.setTargetAtTime(smoothHz(value), time, SMOOTH); break;
      case 'mix':
        this.dry.gain.setTargetAtTime(1 - value, time, SMOOTH);
        this.wet.gain.setTargetAtTime(value, time, SMOOTH);
        break;
    }
  }
}

const smoothHz = (seconds) => 1 / (2 * Math.PI * seconds);

function absCurve() {
  const curve = new Float32Array(4096);
  for (let i = 0; i < curve.length; i++) curve[i] = Math.abs((i / (curve.length - 1)) * 2 - 1);
  return curve;
}
