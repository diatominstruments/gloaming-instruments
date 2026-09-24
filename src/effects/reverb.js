import { Effect, num } from '../module.js';
import { rng, SMOOTH } from '../util.js';

/**
 * Reverb — convolution with a generated impulse: seeded stereo noise under
 * an exponential decay reaching -60 dB at `size` seconds. Seeded, so a room
 * sounds identical everywhere.
 *
 * `size` regenerates the impulse, so it isn't automatable. `damping` is a
 * lowpass on the wet signal and can be swept freely.
 */
export class Reverb extends Effect {
  static id = 'reverb';
  static params = {
    size:     num(0.2, 8, 2, { unit: 's', automatable: false }),
    damping:  num(0, 1, 0.4),
    preDelay: num(0, 0.2, 0.02, { unit: 's' }),
    mix:      num(0, 1, 0.3),
  };

  constructor(ctx, params) {
    super(ctx, params);
    const p = this.params;
    this.dry = new GainNode(ctx, { gain: 1 - p.mix });
    this.wet = new GainNode(ctx, { gain: p.mix });
    this.pre = new DelayNode(ctx, { maxDelayTime: 0.2, delayTime: p.preDelay });
    this.damp = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: dampingHz(p.damping) });

    this.input.connect(this.dry).connect(this.output);
    this.input.connect(this.pre);
    this.damp.connect(this.wet).connect(this.output);
    this.#build(p.size);
  }

  // A fresh ConvolverNode rather than reassigning `buffer`, which older
  // browsers only allow once per node.
  #build(size) {
    if (this.convolver) {
      this.pre.disconnect();
      this.convolver.disconnect();
    }
    this.convolver = new ConvolverNode(this.ctx, { buffer: impulse(this.ctx, size) });
    this.pre.connect(this.convolver).connect(this.damp);
  }

  applyParam(name, value, time) {
    switch (name) {
      case 'size': this.#build(value); break;
      case 'damping': this.damp.frequency.setTargetAtTime(dampingHz(value), time, SMOOTH); break;
      case 'preDelay': this.pre.delayTime.setTargetAtTime(value, time, SMOOTH); break;
      case 'mix':
        this.dry.gain.setTargetAtTime(1 - value, time, SMOOTH);
        this.wet.gain.setTargetAtTime(value, time, SMOOTH);
        break;
    }
  }
}

const dampingHz = (d) => 16000 * 2 ** (-d * 5);   // 0 → 16 kHz, 1 → 500 Hz

function impulse(ctx, size) {
  const length = Math.ceil(size * ctx.sampleRate);
  const buffer = ctx.createBuffer(2, length, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const data = buffer.getChannelData(ch);
    const random = rng(0xbeef + ch);
    for (let i = 0; i < length; i++) {
      data[i] = (random() * 2 - 1) * Math.exp((-6.9 * i) / length);
    }
  }
  return buffer;
}
