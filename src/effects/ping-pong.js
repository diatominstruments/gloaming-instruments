import { Effect, num } from '../module.js';
import { SMOOTH } from '../util.js';

/**
 * PingPong — a stereo delay whose repeats bounce between left and right.
 * Two delay lines feed each other: the input (summed to mono) enters the
 * left line, which repeats into the right, which repeats back into the
 * left. Each line has its own lowpass, so every repeat is darker than the
 * one before and loses `feedback` of its level.
 *
 * `width` blends each side into the other, from hard left/right (1) to
 * centred (0). Like Delay, changing `time` while repeats ring bends them.
 */
export class PingPong extends Effect {
  static id = 'ping-pong';
  static label = 'Ping-Pong Delay';
  static description = 'A stereo delay whose repeats bounce between left and right.';
  static tags = ['time', 'space'];
  static params = {
    time: num(0.01, 2, 0.25, {
      unit: 's', primary: true, label: 'Time', description: 'Gap between repeats, each on the opposite side.',
    }),
    feedback: num(0, 0.95, 0.5, {
      unit: '%', primary: true, label: 'Feedback', description: 'How much of each repeat feeds the next.',
    }),
    tone: num(500, 16000, 4000, {
      unit: 'Hz', scale: 'log', label: 'Tone', description: 'Lowpass on the repeats; lower darkens them faster.',
    }),
    width: num(0, 1, 1, {
      unit: '%', label: 'Width', description: 'How far apart the repeats sit, from centred to hard left and right.',
    }),
    mix: num(0, 1, 0.3, {
      unit: '%', primary: true, label: 'Mix', description: 'Echoes against the dry signal.',
    }),
  };
  static groups = [
    { id: 'echo', label: 'Echo', params: ['time', 'feedback', 'tone'] },
    { id: 'stereo', label: 'Stereo', params: ['width'] },
    { id: 'output', label: 'Output', params: ['mix'] },
  ];
  static presets = {
    'Eighths': { time: 0.24, feedback: 0.45, tone: 4000, width: 1, mix: 0.3 },
    'Wide dub': { time: 0.36, feedback: 0.7, tone: 1800, width: 1, mix: 0.35 },
    'Subtle': { time: 0.12, feedback: 0.25, tone: 6000, width: 0.6, mix: 0.2 },
  };

  constructor(ctx, params) {
    super(ctx, params);
    const p = this.params;
    this.dry = new GainNode(ctx, { gain: 1 - p.mix });
    this.wet = new GainNode(ctx, { gain: p.mix });
    this.input.connect(this.dry).connect(this.output);

    // Mono in, so a stereo source still starts on the left.
    const mono = new GainNode(ctx, { channelCount: 1, channelCountMode: 'explicit', channelInterpretation: 'speakers' });
    const merger = new ChannelMergerNode(ctx, { numberOfInputs: 2 });
    this.input.connect(mono);
    merger.connect(this.wet).connect(this.output);

    // One line per side. `pan` holds [to own side, to other side] gains.
    this.lines = [0, 1].map((side) => {
      const delay = new DelayNode(ctx, { maxDelayTime: 2, delayTime: p.time });
      const tone = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: p.tone });
      const feedback = new GainNode(ctx, { gain: p.feedback });
      const pan = spread(p.width).map((gain) => new GainNode(ctx, { gain }));
      delay.connect(tone).connect(feedback);
      tone.connect(pan[0]).connect(merger, 0, side);
      tone.connect(pan[1]).connect(merger, 0, 1 - side);
      return { delay, tone, feedback, pan };
    });
    const [left, right] = this.lines;
    mono.connect(left.delay);
    left.feedback.connect(right.delay);
    right.feedback.connect(left.delay);
  }

  applyParam(name, value, time) {
    for (const line of this.lines) {
      switch (name) {
        case 'time': line.delay.delayTime.setTargetAtTime(value, time, 0.05); break;
        case 'feedback': line.feedback.gain.setTargetAtTime(value, time, SMOOTH); break;
        case 'tone': line.tone.frequency.setTargetAtTime(value, time, SMOOTH); break;
        case 'width':
          spread(value).forEach((gain, i) => line.pan[i].gain.setTargetAtTime(gain, time, SMOOTH));
          break;
      }
    }
    if (name === 'mix') {
      this.dry.gain.setTargetAtTime(1 - value, time, SMOOTH);
      this.wet.gain.setTargetAtTime(value, time, SMOOTH);
    }
  }
}

// Width 1 keeps each side to itself; width 0 splits it equally.
const spread = (width) => [(1 + width) / 2, (1 - width) / 2];
