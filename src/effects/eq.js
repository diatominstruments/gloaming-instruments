import { Effect, num } from '../module.js';
import { SMOOTH } from '../util.js';

// Web Audio takes lowpass and highpass Q in dB. This is Butterworth (1/√2),
// the flattest passband: 12 dB/octave with no bump at the corner.
const BUTTERWORTH = 20 * Math.log10(Math.SQRT1_2);

const band = (min, max, def, label, description) => num(min, max, def, { unit: 'Hz', scale: 'log', label, description });
const boost = (description, extra = {}) => num(-12, 12, 0, { unit: 'dB', center: 0, label: 'Gain', description, ...extra });

/**
 * EQ — broad tone shaping for a bus or the whole mix: a one-knob tilt,
 * low and high shelves, one peaking band, and low and high cuts.
 *
 * Flat means flat: every gain at 0 dB is an exact passthrough, and each cut
 * at the end of its range switches off rather than leaving a filter
 * shaving the extremes.
 */
export class EQ extends Effect {
  static id = 'eq';
  static label = 'EQ';
  static description = 'Tone shaping for a bus or the mix: tilt, shelves, a mid band and cuts.';
  static tags = ['filter'];
  static params = {
    tilt: num(-6, 6, 0, {
      unit: 'dB', center: 0, primary: true, label: 'Tilt',
      description: 'Darker below zero, brighter above: lows and highs move in opposite directions around the pivot.',
    }),
    pivot: band(200, 5000, 1000, 'Pivot', 'The frequency the tilt turns around, which stays at the same level.'),
    lowGain: boost('Boost or cut everything below the frequency.', { primary: true }),
    lowFreq: band(30, 500, 100, 'Frequency', 'Where the low shelf starts.'),
    midGain: boost('Boost or cut a band around the frequency.'),
    midFreq: band(150, 8000, 1000, 'Frequency', 'The centre of the mid band.'),
    midQ: num(0.3, 8, 0.7, {
      scale: 'log', label: 'Q', description: 'How narrow the mid band is: low values are broad and musical, high ones surgical.',
    }),
    highGain: boost('Boost or cut everything above the frequency.', { primary: true }),
    highFreq: band(1500, 16000, 8000, 'Frequency', 'Where the high shelf starts.'),
    lowCut: band(20, 1000, 20, 'Low cut', 'Removes everything below this frequency. Off at the bottom of its range.'),
    highCut: band(1000, 20000, 20000, 'High cut', 'Removes everything above this frequency. Off at the top of its range.'),
  };
  static groups = [
    { id: 'tilt', label: 'Tilt', params: ['tilt', 'pivot'] },
    { id: 'low', label: 'Low shelf', params: ['lowGain', 'lowFreq'] },
    { id: 'mid', label: 'Mid', params: ['midGain', 'midFreq', 'midQ'] },
    { id: 'high', label: 'High shelf', params: ['highGain', 'highFreq'] },
    { id: 'cut', label: 'Cut', params: ['lowCut', 'highCut'] },
  ];
  static presets = {
    'Warm': { tilt: -2, lowGain: 2, lowFreq: 120, highGain: -1, highFreq: 10000 },
    'Bright': { tilt: 1.5, highGain: 3, highFreq: 12000, lowCut: 30 },
    'Clear the mud': { lowCut: 30, midGain: -3, midFreq: 300, midQ: 1.2 },
    'Smile': { lowGain: 4, lowFreq: 80, midGain: -2, midFreq: 800, midQ: 0.5, highGain: 4, highFreq: 10000 },
    'Telephone': { lowCut: 400, highCut: 3400, midGain: 6, midFreq: 1500, midQ: 1 },
  };

  constructor(ctx, params) {
    super(ctx, params);
    const p = this.params;
    this.lowCut = new BiquadFilterNode(ctx, { type: 'highpass', frequency: this.#lowCutHz(p.lowCut), Q: BUTTERWORTH });
    this.low = new BiquadFilterNode(ctx, { type: 'lowshelf', frequency: p.lowFreq, gain: p.lowGain });
    this.mid = new BiquadFilterNode(ctx, { type: 'peaking', frequency: p.midFreq, Q: p.midQ, gain: p.midGain });
    this.high = new BiquadFilterNode(ctx, { type: 'highshelf', frequency: p.highFreq, gain: p.highGain });
    // A high shelf of `tilt` dB, then half of it taken back across the board:
    // lows move by -tilt/2, highs by +tilt/2, and the pivot stays put.
    this.tiltShelf = new BiquadFilterNode(ctx, { type: 'highshelf', frequency: p.pivot, gain: p.tilt });
    this.tiltLevel = new GainNode(ctx, { gain: tiltLevel(p.tilt) });
    this.highCut = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: this.#highCutHz(p.highCut), Q: BUTTERWORTH });
    this.input.connect(this.lowCut).connect(this.low).connect(this.mid).connect(this.high)
      .connect(this.tiltShelf).connect(this.tiltLevel).connect(this.highCut).connect(this.output);
  }

  applyParam(name, value, time) {
    const set = (param, v) => param.setTargetAtTime(v, time, SMOOTH);
    switch (name) {
      case 'tilt':
        set(this.tiltShelf.gain, value);
        set(this.tiltLevel.gain, tiltLevel(value));
        break;
      case 'pivot': set(this.tiltShelf.frequency, value); break;
      case 'lowGain': set(this.low.gain, value); break;
      case 'lowFreq': set(this.low.frequency, value); break;
      case 'midGain': set(this.mid.gain, value); break;
      case 'midFreq': set(this.mid.frequency, value); break;
      case 'midQ': set(this.mid.Q, value); break;
      case 'highGain': set(this.high.gain, value); break;
      case 'highFreq': set(this.high.frequency, value); break;
      case 'lowCut': set(this.lowCut.frequency, this.#lowCutHz(value)); break;
      case 'highCut': set(this.highCut.frequency, this.#highCutHz(value)); break;
    }
  }

  // At the ends of their ranges the cuts move to where the biquad becomes an
  // exact passthrough: a highpass at 0 Hz, a lowpass at Nyquist.
  #lowCutHz(hz) {
    return hz <= EQ.params.lowCut.min ? 0 : hz;
  }

  #highCutHz(hz) {
    return hz >= EQ.params.highCut.max ? this.ctx.sampleRate / 2 : hz;
  }
}

const tiltLevel = (db) => 10 ** (-db / 40);
