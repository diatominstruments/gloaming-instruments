import { Instrument, num, choice } from '../module.js';
import { mtof, rng, envStart, envRelease, SMOOTH } from '../util.js';

const MAX_VOICES = 6;
/**
 * Length of the noise loops (s). A resonant filter fed a short loop
 * settles into repeating it, which is audible as a rhythm; ten seconds is
 * long enough to hide under the motion.
 */
const NOISE_SECONDS = 10;
/** Every colour of noise is scaled to this RMS, so `color` doesn't change the level. */
const NOISE_RMS = 0.3;
/** Key tracking pivots here: `cutoff` is the frequency for middle C. */
const KEY_TRACK_ROOT = mtof(60);
/** Bandpass Q at no and full resonance; lowpass and highpass peaks at full resonance (dB). */
const BAND_Q = [0.7, 150];
const PEAK_DB = 24;
/**
 * A bandpass passes noise power in proportion to its width f/Q; for pink
 * noise the f cancels, so √Q (from this reference) brings a narrow band
 * back to the level of a wide one. The reference is set so a bandpass
 * comes out about as loud as a lowpass at the same cutoff.
 */
const BAND_REF_Q = 0.2;
/** Smooth random motion: this many seeded points per loop, eased between, each point one LFO cycle. */
const MOTION_POINTS = 64;
const MOTION_STEP = 1024;

// ---- noise -------------------------------------------------------------------

const noiseCache = new WeakMap();

/**
 * Seeded white, pink and brown noise, one buffer each per context and side:
 * white flat, pink falling 3 dB an octave (Paul Kellet's filter), brown
 * 6 dB (a leaky integrator). Each side gets its own seed, so the two are
 * uncorrelated and the texture is wide.
 */
function noises(ctx, side) {
  let all = noiseCache.get(ctx);
  if (!all) noiseCache.set(ctx, (all = []));
  if (!all[side]) {
    const length = Math.round(NOISE_SECONDS * ctx.sampleRate);
    const random = rng(0x7e47 + side);
    const white = new Float32Array(length);
    for (let i = 0; i < length; i++) white[i] = random() * 2 - 1;
    const pink = new Float32Array(length);
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
    for (let i = 0; i < length; i++) {
      const w = white[i];
      b0 = 0.99886 * b0 + w * 0.0555179;
      b1 = 0.99332 * b1 + w * 0.0750759;
      b2 = 0.969 * b2 + w * 0.153852;
      b3 = 0.8665 * b3 + w * 0.3104856;
      b4 = 0.55 * b4 + w * 0.5329522;
      b5 = -0.7616 * b5 - w * 0.016898;
      pink[i] = b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362;
      b6 = w * 0.115926;
    }
    const brown = new Float32Array(length);
    let last = 0;
    for (let i = 0; i < length; i++) brown[i] = last = 0.995 * last + white[i];
    all[side] = [brown, pink, white].map((data) => {
      let mean = 0;
      for (const v of data) mean += v;
      mean /= length;
      let power = 0;
      for (const v of data) power += (v - mean) ** 2;
      const scale = NOISE_RMS / Math.sqrt(power / length);
      const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
      buffer.copyToChannel(data.map((v) => (v - mean) * scale), 0);
      return buffer;
    });
  }
  return all[side];
}

/**
 * Gains for brown, pink and white at `color` −1..1: equal-power crossfades
 * from brown to pink and pink to white (the noises are uncorrelated, so
 * their powers add).
 */
function colorMix(color) {
  const x = Math.abs(color);
  const [near, far] = [Math.cos((x * Math.PI) / 2), Math.sin((x * Math.PI) / 2)];
  return color < 0 ? [far, near, 0] : [0, near, far];
}

let motionWave = null;

/** A loop of seeded random points, eased between with a raised cosine: wind, not a sine. */
function motionBuffer(ctx) {
  if (!motionWave || motionWave.sampleRate !== ctx.sampleRate) {
    const random = rng(0x617);
    const points = Array.from({ length: MOTION_POINTS }, () => random() * 2 - 1);
    const data = new Float32Array(MOTION_POINTS * MOTION_STEP);
    for (let i = 0; i < data.length; i++) {
      const k = Math.floor(i / MOTION_STEP);
      const x = (i % MOTION_STEP) / MOTION_STEP;
      const ease = (1 - Math.cos(Math.PI * x)) / 2;
      data[i] = points[k] + (points[(k + 1) % MOTION_POINTS] - points[k]) * ease;
    }
    motionWave = new AudioBuffer({ length: data.length, sampleRate: ctx.sampleRate });
    motionWave.copyToChannel(data, 0);
  }
  return motionWave;
}

/** Q for a filter of `type` at `resonance` 0..1: a ratio for a bandpass, a peak in dB otherwise. */
function filterQ(type, resonance) {
  return type === 'bandpass' ? BAND_Q[0] * (BAND_Q[1] / BAND_Q[0]) ** resonance : resonance * PEAK_DB;
}

/** Level that keeps a bandpass as loud as a wide one; lowpass and highpass pass enough already. */
const bandLevel = (type, q) => (type === 'bandpass' ? Math.sqrt(q / BAND_REF_Q) : 1);

/**
 * TextureSynth — filtered noise for wind, sea, rain, breath and the
 * risers and sweeps that carry a song between sections.
 *
 * Seeded noise runs all the time, uncorrelated left and right, with
 * `color` crossfading from brown (deep, a distant sea) through pink to
 * white (hiss, rain). Each note filters it through its own resonant
 * filter: `cutoff` is where it sits for middle C, and `keyTrack` how much
 * it follows the note, so at full tracking and high resonance a bandpass
 * whistles at the note's pitch, and chords of wind become possible.
 * Narrow bands are turned up to match wide ones, so resonance doesn't
 * drain the level.
 *
 * `sweep` starts each note's filter that many octaves away and slides it
 * home over `sweepTime`: below with a long attack is a riser, above with
 * a long decay a downlifter.
 *
 * One motion LFO moves every note together, the cutoff by `motion`
 * octaves and the level by `swell`, as wind gusts or waves come in: a
 * smooth random wander, or a sine for the regular roll of a sea. The two
 * sides read it at different points, so gusts move across the field;
 * `width` narrows everything toward mono.
 *
 * The envelope, sweep and key tracking are read at note-on; the filter,
 * colour, motion and width also reach notes already sounding.
 */
export class TextureSynth extends Instrument {
  static id = 'texture-synth';
  static label = 'Texture Synth';
  static description = 'Filtered noise with a moving, resonant filter: wind, sea, rain and breath, pitched whistles, and risers and downlifters for transitions.';
  static tags = ['pad', 'texture'];
  static polyphony = MAX_VOICES;
  static params = {
    color: num(-1, 1, 0, {
      center: 0, primary: true, label: 'Colour',
      description: 'The noise: brown is deep and soft, pink balanced, white bright and hissy.',
      marks: [{ value: -1, label: 'Brown' }, { value: 0, label: 'Pink' }, { value: 1, label: 'White' }],
    }),
    filterType: choice(['lowpass', 'bandpass', 'highpass'], 'bandpass', {
      label: 'Type', description: 'Which part of the noise passes: the lows, a band, or the highs.',
      labels: { lowpass: 'Lowpass', bandpass: 'Bandpass', highpass: 'Highpass' },
    }),
    cutoff: num(20, 16000, 800, {
      unit: 'Hz', scale: 'log', primary: true, label: 'Cutoff', description: 'Where the filter sits, for middle C when it tracks the note.',
    }),
    resonance: num(0, 1, 0.3, {
      unit: '%', label: 'Resonance', description: 'Narrows the band or sharpens the peak; high settings whistle.',
    }),
    keyTrack: num(0, 1, 0, {
      unit: '%', label: 'Key track', description: 'How much the filter follows the note; at 100% a resonant band plays in tune.',
    }),
    sweep: num(-6, 6, 0, {
      unit: 'oct', center: 0, label: 'Sweep', description: 'Where each note\'s filter starts before sliding home: below for a riser, above for a downlifter.',
    }),
    sweepTime: num(0.05, 30, 4, {
      unit: 's', scale: 'log', label: 'Time', description: 'How long the sweep takes.',
    }),
    motion: num(0, 4, 1, {
      unit: 'oct', primary: true, label: 'Motion', description: 'How far the LFO moves the cutoff either way.',
    }),
    swell: num(0, 1, 0.3, {
      unit: '%', label: 'Swell', description: 'How much the LFO moves the level, as gusts or waves come and go.',
    }),
    motionRate: num(0.02, 5, 0.15, {
      unit: 'Hz', scale: 'log', label: 'Rate', description: 'Speed of the motion.',
    }),
    motionShape: choice(['random', 'sine'], 'random', {
      label: 'Shape', description: 'Random wanders like wind; sine rolls evenly like a sea.',
      labels: { random: 'Random', sine: 'Sine' },
    }),
    width: num(0, 1, 1, {
      unit: '%', label: 'Width', description: 'Stereo spread, from mono to fully wide.',
    }),
    attack: num(0.001, 30, 1, {
      unit: 's', scale: 'log', label: 'Attack', description: 'Fade-in at the start of a note.',
    }),
    decay: num(0.01, 30, 1, {
      unit: 's', scale: 'log', label: 'Decay', description: 'Fall from the peak to the sustain level.',
    }),
    sustain: num(0, 1, 1, {
      unit: '%', label: 'Sustain', description: 'Level held while the note is held.',
    }),
    release: num(0.005, 30, 2, {
      unit: 's', scale: 'log', label: 'Release', description: 'Fade-out after the note ends.',
    }),
    gain: num(0, 1, 0.5, { unit: '%', label: 'Level', description: 'Output level.' }),
  };
  static groups = [
    { id: 'noise', label: 'Noise', params: ['color'] },
    {
      id: 'filter', label: 'Filter', params: ['filterType', 'cutoff', 'resonance', 'keyTrack'],
      role: 'filter', bind: { type: 'filterType', cutoff: 'cutoff' },
    },
    { id: 'sweep', label: 'Sweep', params: ['sweep', 'sweepTime'] },
    { id: 'motion', label: 'Motion', params: ['motion', 'swell', 'motionRate', 'motionShape'] },
    {
      id: 'amp', label: 'Amp envelope', params: ['attack', 'decay', 'sustain', 'release'],
      role: 'envelope', bind: { attack: 'attack', decay: 'decay', sustain: 'sustain', release: 'release' },
    },
    { id: 'output', label: 'Output', params: ['width', 'gain'] },
  ];
  static presets = {
    'Wind': {
      color: 0.1, filterType: 'bandpass', cutoff: 700, resonance: 0.4, motion: 1.6, swell: 0.6, motionRate: 0.18,
      attack: 2, release: 3,
    },
    'Sea': {
      color: -0.7, filterType: 'lowpass', cutoff: 450, resonance: 0.1, motion: 2.2, swell: 0.85, motionRate: 0.09,
      motionShape: 'sine', attack: 3, release: 4,
    },
    'Rain': { color: 1, filterType: 'highpass', cutoff: 2500, resonance: 0.1, motion: 0.3, swell: 0.15, motionRate: 0.4, attack: 1.5, release: 2 },
    'Whistling wind': {
      color: 0, filterType: 'bandpass', cutoff: 1046.5, resonance: 0.85, keyTrack: 1, motion: 0.15, swell: 0.5,
      motionRate: 0.25, attack: 1.2, release: 2.5,
    },
    'Breath pad': {
      color: -0.2, filterType: 'bandpass', cutoff: 523.25, resonance: 0.7, keyTrack: 1, motion: 0.1, swell: 0.2,
      attack: 0.4, release: 1.2,
    },
    'Riser': {
      color: 0.6, filterType: 'bandpass', cutoff: 3000, resonance: 0.55, sweep: -5, sweepTime: 8, motion: 0.2, swell: 0,
      attack: 8, release: 0.3,
    },
    'Downlifter': {
      color: 0.6, filterType: 'bandpass', cutoff: 150, resonance: 0.5, sweep: 5, sweepTime: 4, motion: 0, swell: 0,
      attack: 0.005, decay: 4, sustain: 0, release: 0.5,
    },
    'Air': { color: 0.8, filterType: 'highpass', cutoff: 6000, resonance: 0.2, motion: 0.5, swell: 0.3, attack: 0.5, release: 1 },
  };

  constructor(ctx, params) {
    super(ctx, params);
    const p = this.params;
    this.voices = new Map();   // held note -> voice, in start order
    this.live = new Set();     // every voice still sounding, held or releasing

    // Per side: the three noises through their colour gains into a bus
    // that each voice's filter reads from.
    this.sides = [0, 1].map((side) => {
      const bus = new GainNode(ctx);
      const colors = noises(ctx, side).map((buffer, k) => {
        const source = new AudioBufferSourceNode(ctx, { buffer, loop: true });
        const gain = new GainNode(ctx, { gain: colorMix(p.color)[k] });
        source.connect(gain).connect(bus);
        source.start();
        return { source, gain };
      });
      // Motion into every voice's cutoff (cents), and into this side's level.
      const motion = new GainNode(ctx, { gain: p.motion * 1200 });
      const swell = new GainNode(ctx, { gain: 1 - p.swell / 2 });
      const swellDepth = new GainNode(ctx, { gain: p.swell / 2 });
      swellDepth.connect(swell.gain);
      return { bus, colors, motion, swell, swellDepth };
    });

    // Voices into a stereo mix, each side through its swell, then the width
    // matrix: [to own side, to the other], as on the ping-pong delay.
    this.mix = new GainNode(ctx, { channelCount: 2, channelCountMode: 'explicit', channelInterpretation: 'discrete' });
    const split = new ChannelSplitterNode(ctx, { numberOfOutputs: 2 });
    const merge = new ChannelMergerNode(ctx, { numberOfInputs: 2 });
    this.mix.connect(split);
    this.pan = this.sides.map((s, side) => {
      split.connect(s.swell, side);
      return spread(p.width).map((gain, k) => {
        const node = new GainNode(ctx, { gain });
        s.swell.connect(node).connect(merge, 0, k ? 1 - side : side);
        return node;
      });
    });
    merge.connect(this.output);
    this.#startMotion();
  }

  /**
   * (Re)start the motion LFO in its shape, replacing any running: the
   * random wander from its looped buffer, or a sine. The right side reads
   * the wander half a loop on, or the sine a quarter turn later.
   */
  #startMotion() {
    const ctx = this.ctx;
    const { motionShape, motionRate } = this.params;
    for (const old of this.lfos ?? []) old.stop();
    const t = ctx.currentTime;
    this.lfos = this.sides.map((s, side) => {
      let lfo;
      if (motionShape === 'random') {
        lfo = new AudioBufferSourceNode(ctx, { buffer: motionBuffer(ctx), loop: true, playbackRate: this.#motionPlayback(motionRate) });
        lfo.start(t, side * (MOTION_POINTS / 2) * (MOTION_STEP / ctx.sampleRate));
      } else {
        const phase = side * (Math.PI / 2);
        lfo = new OscillatorNode(ctx, {
          frequency: motionRate,
          periodicWave: new PeriodicWave(ctx, { real: [0, Math.sin(phase)], imag: [0, Math.cos(phase)], disableNormalization: true }),
        });
        lfo.start(t);
      }
      lfo.connect(s.motion);
      lfo.connect(s.swellDepth);
      return lfo;
    });
  }

  /** Playback rate at which the random wander moves to a new point `hz` times a second. */
  #motionPlayback(hz) {
    return (hz * MOTION_STEP) / this.ctx.sampleRate;
  }

  noteOn(note, velocity = 1, time) {
    const t = this.at(time);
    this.#release(note, t, 0.005);
    if (this.voices.size >= MAX_VOICES) this.#release(this.voices.keys().next().value, t, 0.005);
    const voice = this.#voice(note, velocity, t);
    this.voices.set(note, voice);
    this.live.add(voice);
  }

  noteOff(note, time) {
    this.#release(note, this.at(time), this.params.release);
  }

  allNotesOff(time) {
    const t = this.at(time);
    for (const note of [...this.voices.keys()]) this.#release(note, t, 0.005);
  }

  /** One note: a filter per side off the noise buses, a level for narrow bands, and the amp. */
  #voice(note, velocity, t) {
    const ctx = this.ctx;
    const p = this.params;
    const voice = { keyScale: (mtof(note) / KEY_TRACK_ROOT) ** p.keyTrack };
    voice.amp = new GainNode(ctx, { gain: 0 });
    voice.amp.connect(this.mix);
    const merge = new ChannelMergerNode(ctx, { numberOfInputs: 2 });
    voice.level = new GainNode(ctx, { channelCount: 2, channelCountMode: 'explicit', channelInterpretation: 'discrete' });
    merge.connect(voice.level).connect(voice.amp);
    voice.filters = this.sides.map((s, side) => {
      const filter = new BiquadFilterNode(ctx, { type: p.filterType });
      s.bus.connect(filter).connect(merge, 0, side);
      s.motion.connect(filter.detune);
      if (p.sweep !== 0) {
        filter.detune.setValueAtTime(p.sweep * 1200, t);
        filter.detune.linearRampToValueAtTime(0, t + p.sweepTime);
      }
      return filter;
    });
    this.#tune(voice);
    envStart(voice.amp.gain, t, { attack: p.attack, decay: p.decay, sustain: p.sustain, peak: velocity });
    return voice;
  }

  /** A voice's filters and band level from the current filter params. `time` undefined sets them directly. */
  #tune(voice, time) {
    const { filterType, cutoff, resonance } = this.params;
    const nyquist = this.ctx.sampleRate / 2;
    const q = filterQ(filterType, resonance);
    for (const f of voice.filters) {
      f.type = filterType;
      set(f.frequency, Math.min(cutoff * voice.keyScale, nyquist), time);
      set(f.Q, q, time);
    }
    set(voice.level.gain, bandLevel(filterType, q), time);
  }

  #release(note, t, release) {
    const voice = this.voices.get(note);
    if (!voice) return;
    this.voices.delete(note);
    envRelease(voice.amp.gain, t, release);
    // Torn down once it's certainly silent. The voice has no source of its
    // own to signal that, so a silent one stands in; it has to be connected,
    // as Chrome doesn't run (or end) sources nothing listens to.
    const done = new ConstantSourceNode(this.ctx, { offset: 0 });
    done.connect(voice.amp);
    done.onended = () => {
      voice.amp.disconnect();
      voice.filters.forEach((f, side) => {
        this.sides[side].bus.disconnect(f);
        this.sides[side].motion.disconnect(f.detune);
      });
      this.live.delete(voice);
    };
    done.start(t);
    done.stop(t + release * 2 + 0.05);
  }

  applyParam(name, value, time) {
    switch (name) {
      case 'color':
        for (const s of this.sides) colorMix(value).forEach((g, k) => s.colors[k].gain.gain.setTargetAtTime(g, time, SMOOTH));
        break;
      case 'filterType':
      case 'cutoff':
      case 'resonance':
        for (const voice of this.live) this.#tune(voice, time);
        break;
      case 'motion': for (const s of this.sides) s.motion.gain.setTargetAtTime(value * 1200, time, SMOOTH); break;
      case 'swell':
        for (const s of this.sides) {
          s.swell.gain.setTargetAtTime(1 - value / 2, time, SMOOTH);
          s.swellDepth.gain.setTargetAtTime(value / 2, time, SMOOTH);
        }
        break;
      case 'motionRate':
        for (const lfo of this.lfos) {
          if (lfo instanceof OscillatorNode) lfo.frequency.setTargetAtTime(value, time, SMOOTH);
          else lfo.playbackRate.setTargetAtTime(this.#motionPlayback(value), time, SMOOTH);
        }
        break;
      case 'motionShape': this.#startMotion(); break;
      case 'width':
        for (const side of this.pan) spread(value).forEach((g, k) => side[k].gain.setTargetAtTime(g, time, SMOOTH));
        break;
      default: super.applyParam(name, value, time);
    }
  }

  dispose() {
    for (const lfo of this.lfos) lfo.stop();
    for (const s of this.sides) for (const { source } of s.colors) source.stop();
    super.dispose();
  }
}

// Width 1 keeps each side to itself; width 0 splits it equally.
const spread = (width) => [(1 + width) / 2, (1 - width) / 2];

/** Set a param now (`time` undefined), or glide it there from `time`. */
function set(param, value, time) {
  if (time == null) param.value = value;
  else param.setTargetAtTime(value, time, SMOOTH);
}
