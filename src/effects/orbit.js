import { Effect, num } from '../module.js';
import { SMOOTH } from '../util.js';

/**
 * Orbit — the sound circles the listener. A PannerNode with HRTF (so it
 * works on headphones) is moved by two LFOs, a sine on x and a cosine on
 * z, `radius` metres out; `height` lifts the circle above or below ear
 * level. Beyond a metre the source also gets quieter with distance, which
 * is most of what "far" sounds like.
 *
 * The context's listener is left alone (it's shared with everything else on
 * the context); the orbit is centred on wherever it is by default, the origin.
 */
export class Orbit extends Effect {
  static id = 'orbit';
  static label = 'Orbit';
  static description = 'Circles the sound around the listener. For headphones.';
  static tags = ['space', 'modulation'];
  static params = {
    rate: num(0.02, 8, 0.25, {
      unit: 'Hz', scale: 'log', primary: true, label: 'Rate', description: 'Orbits per second.',
    }),
    radius: num(0.2, 5, 1.5, {
      unit: 'm', primary: true, label: 'Distance', description: 'How far out the orbit runs; further is quieter.',
    }),
    height: num(-2, 2, 0, {
      unit: 'm', center: 0, label: 'Height', description: 'Above or below ear level.',
    }),
  };
  static groups = [
    { id: 'orbit', label: 'Orbit', params: ['rate', 'radius', 'height'] },
  ];
  static presets = {
    'Slow drift': { rate: 0.08, radius: 2, height: 0 },
    'Close circle': { rate: 0.3, radius: 0.6, height: 0 },
    'Spin': { rate: 3, radius: 1, height: 0.5 },
  };

  constructor(ctx, params) {
    super(ctx, params);
    const p = this.params;
    this.panner = new PannerNode(ctx, {
      panningModel: 'HRTF',
      distanceModel: 'inverse',
      refDistance: 1,
      rolloffFactor: 0.5,
      positionY: p.height,
    });
    this.input.connect(this.panner).connect(this.output);

    // A cosine is a PeriodicWave with a single real coefficient; starting it
    // and the sine together keeps them a quarter turn apart forever.
    const cosine = ctx.createPeriodicWave(new Float32Array([0, 1]), new Float32Array([0, 0]),
      { disableNormalization: true });
    this.sin = new OscillatorNode(ctx, { frequency: p.rate });
    this.cos = new OscillatorNode(ctx, { frequency: p.rate, periodicWave: cosine });
    this.x = new GainNode(ctx, { gain: p.radius });
    this.z = new GainNode(ctx, { gain: p.radius });
    this.sin.connect(this.x).connect(this.panner.positionX);
    this.cos.connect(this.z).connect(this.panner.positionZ);
    this.sin.start();
    this.cos.start();
  }

  applyParam(name, value, time) {
    switch (name) {
      case 'rate':
        this.sin.frequency.setTargetAtTime(value, time, SMOOTH);
        this.cos.frequency.setTargetAtTime(value, time, SMOOTH);
        break;
      case 'radius':
        this.x.gain.setTargetAtTime(value, time, SMOOTH);
        this.z.gain.setTargetAtTime(value, time, SMOOTH);
        break;
      case 'height': this.panner.positionY.setTargetAtTime(value, time, SMOOTH); break;
    }
  }

  dispose() {
    this.sin.stop();
    this.cos.stop();
    super.dispose();
  }
}
