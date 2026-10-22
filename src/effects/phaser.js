import { Effect, num, choice } from '../module.js';
import { SMOOTH } from '../util.js';

/**
 * Phaser — the input through a chain of allpass filters, mixed back with
 * itself. Each allpass passes every frequency at full level but delays the
 * phase around its corner, so where the chain's shift reaches a half turn
 * the two copies cancel: a set of notches, one for every two stages, that
 * a sine LFO sweeps up and down the spectrum. `q` sharpens the phase turn
 * around the corner, which narrows the notches.
 *
 * Left and right have their own chains, swept `stereo` of a half cycle
 * apart, so the notches chase each other across the field. The right
 * side's LFO is a blend of a sine and a cosine started together, which
 * makes that offset an ordinary, automatable gain.
 *
 * There's no feedback. Web Audio can only run a loop through a delay of at
 * least one render quantum (~3 ms), which would add a comb filter of its own
 * instead of deepening the notches; more stages and a higher `q` are the
 * way to a stronger effect.
 *
 * `mix` at 50% gives the deepest notches; above it, the sound turns to
 * vibrato as the wet copy takes over.
 */
export class Phaser extends Effect {
  static id = 'phaser';
  static label = 'Phaser';
  static description = 'Sweeping notches from a chain of allpass filters, with a stereo offset. Swirls on keys, pads, guitars and drums.';
  static tags = ['modulation', 'filter'];
  static params = {
    rate: num(0.02, 10, 0.4, {
      unit: 'Hz', scale: 'log', primary: true, label: 'Rate', description: 'Speed of the sweep.',
    }),
    depth: num(0, 4, 1.5, {
      unit: 'oct', primary: true, label: 'Depth', description: 'How far the sweep moves either side of the centre.',
    }),
    frequency: num(100, 4000, 700, {
      unit: 'Hz', scale: 'log', label: 'Centre', description: 'Middle of the sweep.',
    }),
    stages: choice(['4', '6', '8', '12'], '6', {
      label: 'Stages', description: 'Allpass filters in the chain: every two make one notch.',
    }),
    q: num(0.2, 4, 0.7, {
      scale: 'log', label: 'Q', description: 'Higher narrows the notches, for a sharper, more resonant sweep.',
    }),
    stereo: num(0, 1, 0.5, {
      unit: '%', label: 'Stereo', description: 'How far apart the two sides\' sweeps run, up to opposite directions.',
    }),
    mix: num(0, 1, 0.5, {
      unit: '%', primary: true, label: 'Mix', description: 'Phased against the dry signal; 50% gives the deepest notches.',
    }),
  };
  static groups = [
    { id: 'sweep', label: 'Sweep', params: ['rate', 'depth', 'frequency'] },
    { id: 'notches', label: 'Notches', params: ['stages', 'q'] },
    { id: 'output', label: 'Output', params: ['stereo', 'mix'] },
  ];
  static presets = {
    'Classic': { rate: 0.4, depth: 1.5, frequency: 700, stages: '4', q: 0.7, stereo: 0.3, mix: 0.5 },
    'Deep swirl': { rate: 0.15, depth: 2.5, frequency: 900, stages: '8', q: 1, stereo: 0.5, mix: 0.5 },
    'Jet': { rate: 0.05, depth: 3, frequency: 1200, stages: '12', q: 2.5, stereo: 0.25, mix: 0.5 },
    'Fast warble': { rate: 5, depth: 0.8, frequency: 600, stages: '6', q: 0.7, stereo: 1, mix: 0.5 },
    'Wide': { rate: 0.25, depth: 1.8, frequency: 800, stages: '6', q: 0.9, stereo: 1, mix: 0.45 },
  };

  constructor(ctx, params) {
    super(ctx, params);
    const p = this.params;
    this.dry = new GainNode(ctx, { gain: 1 - p.mix });
    this.wet = new GainNode(ctx, { gain: p.mix });
    this.input.connect(this.dry).connect(this.output);

    // Stereo in (a mono source feeds both sides), split into the two chains.
    this.stereo = new GainNode(ctx, { channelCount: 2, channelCountMode: 'explicit', channelInterpretation: 'speakers' });
    this.split = new ChannelSplitterNode(ctx, { numberOfOutputs: 2 });
    this.merge = new ChannelMergerNode(ctx, { numberOfInputs: 2 });
    this.input.connect(this.stereo).connect(this.split);
    this.merge.connect(this.wet).connect(this.output);

    // A sine and a cosine, started together so they stay a quarter turn
    // apart. Left follows the sine; right a blend that leads it by `stereo`.
    const cosine = new PeriodicWave(ctx, { real: [0, 1], imag: [0, 0], disableNormalization: true });
    this.sin = new OscillatorNode(ctx, { frequency: p.rate });
    this.cos = new OscillatorNode(ctx, { frequency: p.rate, periodicWave: cosine });
    this.sweeps = [
      [new GainNode(ctx)],
      [new GainNode(ctx), new GainNode(ctx)],
    ];
    this.sin.connect(this.sweeps[0][0]);
    this.sin.connect(this.sweeps[1][0]);
    this.cos.connect(this.sweeps[1][1]);
    this.#depth();
    const t = ctx.currentTime;
    this.sin.start(t);
    this.cos.start(t);

    this.#build();
  }

  /** Each side's chain of allpasses, replacing any already built, with the sweep wired to every stage. */
  #build() {
    const { stages, frequency, q } = this.params;
    if (this.chains) {
      this.split.disconnect();
      for (const chain of this.chains) chain.at(-1).disconnect();
      for (const gains of this.sweeps) for (const gain of gains) gain.disconnect();
    }
    this.chains = [0, 1].map((side) => {
      const chain = Array.from({ length: Number(stages) }, () =>
        new BiquadFilterNode(this.ctx, { type: 'allpass', frequency, Q: q }));
      chain.reduce((from, stage) => from.connect(stage));
      this.split.connect(chain[0], side);
      chain.at(-1).connect(this.merge, 0, side);
      for (const gain of this.sweeps[side]) for (const stage of chain) gain.connect(stage.detune);
      return chain;
    });
  }

  /**
   * The sweep, in cents on every stage's detune: left gets the sine, right
   * sin(ωt + φ) = cos φ·sin ωt + sin φ·cos ωt, with φ = `stereo` × π.
   * `time` undefined sets values directly.
   */
  #depth(time) {
    const { depth, stereo } = this.params;
    const cents = depth * 1200;
    const phase = stereo * Math.PI;
    const [[left], [rightSin, rightCos]] = this.sweeps;
    set(left.gain, cents, time);
    set(rightSin.gain, cents * Math.cos(phase), time);
    set(rightCos.gain, cents * Math.sin(phase), time);
  }

  applyParam(name, value, time) {
    const stages = () => this.chains.flat();
    switch (name) {
      case 'rate':
        this.sin.frequency.setTargetAtTime(value, time, SMOOTH);
        this.cos.frequency.setTargetAtTime(value, time, SMOOTH);
        break;
      case 'depth':
      case 'stereo':
        this.#depth(time);
        break;
      case 'frequency': for (const stage of stages()) stage.frequency.setTargetAtTime(value, time, SMOOTH); break;
      case 'q': for (const stage of stages()) stage.Q.setTargetAtTime(value, time, SMOOTH); break;
      case 'stages': this.#build(); break;
      case 'mix':
        this.dry.gain.setTargetAtTime(1 - value, time, SMOOTH);
        this.wet.gain.setTargetAtTime(value, time, SMOOTH);
        break;
    }
  }

  dispose() {
    this.sin.stop();
    this.cos.stop();
    super.dispose();
  }
}

/** Set a param now (`time` undefined), or glide it there from `time`. */
function set(param, value, time) {
  if (time == null) param.value = value;
  else param.setTargetAtTime(value, time, SMOOTH);
}
