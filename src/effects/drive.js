import { Effect, num } from '../module.js';
import { SMOOTH } from '../util.js';

// The shaper's curve spans inputs of ±1, so the signal is scaled down by
// HEADROOM on the way in and the curve scaled up to match. Net transfer is
// tanh(signal × drive) for anything up to HEADROOM / drive, and flat-out
// saturated beyond — which lets `drive` be a plain, automatable gain.
const HEADROOM = 8;

function tanhCurve() {
  const curve = new Float32Array(4096);
  for (let i = 0; i < curve.length; i++) {
    const x = (i / (curve.length - 1)) * 2 - 1;
    curve[i] = Math.tanh(x * HEADROOM);
  }
  return curve;
}

/** Drive — tanh saturation with a tone control. Warm at low settings, fuzz at high ones. */
export class Drive extends Effect {
  static id = 'drive';
  static params = {
    drive: num(0, 40, 12, { unit: 'dB' }),
    tone:  num(500, 16000, 6000, { unit: 'Hz', scale: 'log' }),
    level: num(0, 1, 0.6),
  };

  constructor(ctx, params) {
    super(ctx, params);
    const p = this.params;
    this.pre = new GainNode(ctx, { gain: preGain(p.drive) });
    this.shaper = new WaveShaperNode(ctx, { curve: tanhCurve(), oversample: '4x' });
    this.tone = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: p.tone });
    this.level = new GainNode(ctx, { gain: p.level });
    this.input.connect(this.pre).connect(this.shaper).connect(this.tone).connect(this.level).connect(this.output);
  }

  applyParam(name, value, time) {
    switch (name) {
      case 'drive': this.pre.gain.setTargetAtTime(preGain(value), time, SMOOTH); break;
      case 'tone': this.tone.frequency.setTargetAtTime(value, time, SMOOTH); break;
      case 'level': this.level.gain.setTargetAtTime(value, time, SMOOTH); break;
    }
  }
}

const preGain = (db) => 10 ** (db / 20) / HEADROOM;
