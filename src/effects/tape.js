import { Effect, num } from '../module.js';
import { noiseBuffer, SMOOTH } from '../util.js';

const WOW_HZ = 0.6;
const FLUTTER_HZ = 6.7;
const WOW_DEPTH = 0.004;       // s of delay swing at wow = 1
const FLUTTER_DEPTH = 0.0002;  // s of delay swing at flutter = 1
const BASE_DELAY = 0.005;      // headroom for the swings, never negative
const HEADROOM = 8;

/**
 * Tape — a tape machine's imperfections. Wow (slow) and flutter (fast)
 * are a short delay whose time wobbles under two LFOs, bending the pitch;
 * `saturation` is tanh soft clipping with half the drive made up afterwards,
 * so peaks compress and quiet passages come forward; `tone` is the head's high-frequency rolloff;
 * and `hiss` is seeded noise under the same rolloff.
 *
 * Always fully wet: this goes on a bus, not in parallel.
 */
export class Tape extends Effect {
  static id = 'tape';
  static label = 'Tape';
  static description = "A tape machine's character: wow and flutter, saturation, head rolloff and hiss.";
  static tags = ['character', 'distortion', 'modulation'];
  static params = {
    saturation: num(0, 24, 6, {
      unit: 'dB', primary: true, label: 'Saturation', description: 'Soft clipping that squashes peaks.',
    }),
    wow: num(0, 1, 0.3, {
      unit: '%', primary: true, label: 'Wow', description: 'Slow pitch drift.',
    }),
    flutter: num(0, 1, 0.2, {
      unit: '%', label: 'Flutter', description: 'Fast pitch wobble.',
    }),
    tone: num(1000, 20000, 10000, {
      unit: 'Hz', scale: 'log', label: 'Tone', description: 'High-frequency rolloff of the heads.',
    }),
    hiss: num(0, 1, 0.15, {
      unit: '%', label: 'Hiss', description: 'Background tape noise.',
    }),
  };
  static groups = [
    { id: 'signal', label: 'Signal', params: ['saturation', 'tone'] },
    { id: 'transport', label: 'Transport', params: ['wow', 'flutter'] },
    { id: 'noise', label: 'Noise', params: ['hiss'] },
  ];
  static presets = {
    'Clean deck': { saturation: 3, wow: 0.1, flutter: 0.05, tone: 16000, hiss: 0.05 },
    'Worn cassette': { saturation: 9, wow: 0.6, flutter: 0.4, tone: 6000, hiss: 0.35 },
    'Warped': { saturation: 6, wow: 1, flutter: 0.3, tone: 8000, hiss: 0.2 },
  };

  constructor(ctx, params) {
    super(ctx, params);
    const p = this.params;

    this.pre = new GainNode(ctx, { gain: preGain(p.saturation) });
    this.shaper = new WaveShaperNode(ctx, { curve: tanhCurve(), oversample: '2x' });
    this.post = new GainNode(ctx, { gain: postGain(p.saturation) });
    this.wobble = new DelayNode(ctx, { maxDelayTime: 0.05, delayTime: BASE_DELAY });
    this.tone = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: p.tone, Q: -3 });
    this.input.connect(this.pre).connect(this.shaper).connect(this.post)
      .connect(this.wobble).connect(this.tone).connect(this.output);

    this.wow = new OscillatorNode(ctx, { frequency: WOW_HZ });
    this.wowDepth = new GainNode(ctx, { gain: p.wow * WOW_DEPTH });
    this.flutter = new OscillatorNode(ctx, { frequency: FLUTTER_HZ });
    this.flutterDepth = new GainNode(ctx, { gain: p.flutter * FLUTTER_DEPTH });
    this.wow.connect(this.wowDepth).connect(this.wobble.delayTime);
    this.flutter.connect(this.flutterDepth).connect(this.wobble.delayTime);

    this.noise = new AudioBufferSourceNode(ctx, { buffer: noiseBuffer(ctx), loop: true });
    this.hiss = new GainNode(ctx, { gain: hissGain(p.hiss) });
    this.noise.connect(this.hiss).connect(this.tone);

    for (const node of [this.wow, this.flutter, this.noise]) node.start();
  }

  applyParam(name, value, time) {
    switch (name) {
      case 'saturation':
        this.pre.gain.setTargetAtTime(preGain(value), time, SMOOTH);
        this.post.gain.setTargetAtTime(postGain(value), time, SMOOTH);
        break;
      case 'wow': this.wowDepth.gain.setTargetAtTime(value * WOW_DEPTH, time, SMOOTH); break;
      case 'flutter': this.flutterDepth.gain.setTargetAtTime(value * FLUTTER_DEPTH, time, SMOOTH); break;
      case 'tone': this.tone.frequency.setTargetAtTime(value, time, SMOOTH); break;
      case 'hiss': this.hiss.gain.setTargetAtTime(hissGain(value), time, SMOOTH); break;
    }
  }

  dispose() {
    for (const node of [this.wow, this.flutter, this.noise]) node.stop();
    super.dispose();
  }
}

// Same scheme as Drive: the curve spans ±1 and is tanh(x × HEADROOM), and the
// signal is scaled down by HEADROOM on the way in, so the net transfer is
// tanh(signal × drive) for anything the curve covers. Half the drive (in
// dB) is taken back after the curve: peaks squash and the mix gets denser
// without the level running away in either direction.
const preGain = (db) => 10 ** (db / 20) / HEADROOM;
const postGain = (db) => 10 ** (-db / 40);
const hissGain = (h) => h * h * 0.03;   // squared for finer control down low; -67 dB at the default

function tanhCurve() {
  const curve = new Float32Array(4096);
  for (let i = 0; i < curve.length; i++) {
    const x = (i / (curve.length - 1)) * 2 - 1;
    curve[i] = Math.tanh(x * HEADROOM);
  }
  return curve;
}
