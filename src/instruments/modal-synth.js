import { Instrument, num, choice } from '../module.js';
import { mtof, noiseBuffer, envRelease } from '../util.js';

const MAX_VOICES = 12;
const STRIKE = 0.003;   // exciter burst length (s)

/**
 * Mode tables: each material is a list of partial frequencies as ratios of
 * the note's fundamental. They come from the physics of the shape — a free
 * bar's bending modes, the partial series of a bell — and are what makes
 * wood sound like wood and steel like steel. A tuned (marimba-style) bar
 * has its second partial shaved to a double octave.
 */
const MATERIALS = {
  wood:  [1, 3.93, 9.54, 16.3],
  glass: [1, 2.32, 3.86, 5.62, 7.58, 9.7],
  steel: [1, 2.76, 5.40, 8.93, 13.34, 18.64],
  bell:  [0.5, 1, 1.2, 1.5, 2, 2.51, 3, 4],
};

/**
 * ModalSynth — struck bars, bowls, plates and bells. Each note is a bank of
 * high-Q bandpass filters, one per partial of the chosen material, rung by
 * a few milliseconds of noise. `strike` is mallet hardness (a lowpass on
 * the noise, so soft mallets don't reach the upper partials), `decay` the
 * fundamental's ring time and `damping` how much faster the upper partials
 * die away. Harder hits are brighter as well as louder.
 *
 * Every mode's gain is compensated for its Q, so changing `decay` doesn't
 * change loudness — a resonator with a longer ring is a quieter one, and
 * we make up the difference.
 *
 * In 'one-shot' mode noteOff is ignored and repeated strikes pile up, like
 * a real bar; in 'gate' mode noteOff damps the note over `release`.
 */
export class ModalSynth extends Instrument {
  static id = 'modal-synth';
  static label = 'Modal Synth';
  static description = 'Struck bars, bowls and bells: a bank of resonators per note, rung by a mallet.';
  static tags = ['mallet', 'bell', 'percussion'];
  static polyphony = MAX_VOICES;
  static gated = { mode: 'gate' };
  static params = {
    material: choice(Object.keys(MATERIALS), 'glass', {
      primary: true, label: 'Material', description: 'What is struck, which sets the pattern of overtones.',
      labels: { wood: 'Wood', glass: 'Glass', steel: 'Steel', bell: 'Bell' },
    }),
    mode: choice(['one-shot', 'gate'], 'one-shot', {
      label: 'Mode', description: 'One-shot lets each strike ring out; gated damps it at note off.',
      labels: { 'one-shot': 'One-shot', gate: 'Gated' },
    }),
    strike: num(0, 1, 0.6, {
      unit: '%', label: 'Hardness', description: "Mallet hardness: soft mallets don't reach the upper overtones.",
    }),
    brightness: num(0, 1, 0.5, {
      unit: '%', label: 'Brightness', description: 'Level of the upper overtones against the fundamental.',
    }),
    decay: num(0.05, 10, 2, {
      unit: 's', scale: 'log', primary: true, label: 'Decay', description: 'Ring time of the fundamental.',
    }),
    damping: num(0, 1, 0.4, {
      unit: '%', label: 'Damping', description: 'How much faster the upper overtones die away.',
    }),
    release: num(0.005, 2, 0.05, {
      unit: 's', scale: 'log', activeWhen: { mode: 'gate' },
      label: 'Release', description: 'How quickly a note is damped at note off.',
    }),
    gain: num(0, 1, 0.6, { unit: '%', label: 'Level', description: 'Output level.' }),
  };
  static groups = [
    { id: 'body', label: 'Body', params: ['material', 'decay', 'damping', 'brightness'] },
    { id: 'mallet', label: 'Mallet', params: ['strike'] },
    { id: 'note', label: 'Note', params: ['mode', 'release'] },
    { id: 'output', label: 'Output', params: ['gain'] },
  ];
  static presets = {
    'Marimba': { material: 'wood', strike: 0.4, brightness: 0.4, decay: 0.8, damping: 0.5 },
    'Glass bowl': { material: 'glass', strike: 0.3, brightness: 0.6, decay: 6, damping: 0.2 },
    'Glockenspiel': { material: 'steel', strike: 0.8, brightness: 0.7, decay: 3, damping: 0.3 },
    'Church bell': { material: 'bell', strike: 0.7, brightness: 0.6, decay: 8, damping: 0.35 },
  };

  constructor(ctx, params) {
    super(ctx, params);
    this.voices = [];   // { note, amp, source, released }, in start order
  }

  noteOn(note, velocity = 1, time) {
    const t = this.at(time);
    const p = this.params;
    const ctx = this.ctx;
    if (this.voices.length >= MAX_VOICES) this.#release(this.voices[0], t, 0.005);

    const hz = mtof(note);
    const fs = ctx.sampleRate;
    const nyquist = fs * 0.45;

    // A short noise burst, shaped by the mallet: a lowpass whose cutoff
    // rises with `strike` and with velocity.
    const source = new AudioBufferSourceNode(ctx, { buffer: noiseBuffer(ctx), loop: true });
    const burst = new GainNode(ctx, { gain: 0 });
    const mallet = new BiquadFilterNode(ctx, {
      type: 'lowpass',
      frequency: 300 * 40 ** p.strike * (0.5 + 0.5 * velocity),
      Q: 0,
    });
    burst.gain.setValueAtTime(1 / Math.sqrt(STRIKE * fs), t);
    burst.gain.setValueAtTime(0, t + STRIKE);
    source.connect(burst).connect(mallet);

    // One resonator per partial. A bandpass biquad's impulse response peaks
    // at 2πf/(fs·Q), so each mode is scaled by the inverse to ring at unit
    // level, which makes the gain independent of frequency and decay. The
    // voice is then trimmed by the modes' combined level, so a bell with
    // eight partials comes out as loud as a bar with four.
    const tilt = (1 - p.brightness) * 2;
    const modes = MATERIALS[p.material]
      .filter((ratio) => hz * ratio < nyquist)
      .map((ratio) => ({
        f: hz * ratio,
        t60: p.decay * ratio ** (-p.damping * 2),
        level: Math.min(1, ratio ** -tilt),
      }));
    const loudness = Math.sqrt(modes.reduce((sum, m) => sum + m.level ** 2, 0)) || 1;
    const amp = new GainNode(ctx, { gain: (0.5 * velocity) / loudness });
    amp.connect(this.output);

    let longest = 0;
    for (const { f, t60, level } of modes) {
      const q = (Math.PI * f * t60) / 6.9;
      const filter = new BiquadFilterNode(ctx, { type: 'bandpass', frequency: f, Q: q });
      const modeGain = new GainNode(ctx, { gain: (level * q * fs) / (2 * Math.PI * f) });
      mallet.connect(filter).connect(modeGain).connect(amp);
      longest = Math.max(longest, t60);
    }

    // The source outlives the burst so its `onended` can tear the voice down
    // once the ring has faded.
    const voice = { note, amp, source, released: false };
    source.onended = () => {
      amp.disconnect();
      const i = this.voices.indexOf(voice);
      if (i >= 0) this.voices.splice(i, 1);
    };
    source.start(t, (note * 0.0137) % 1.9);
    amp.gain.setTargetAtTime(0, t + longest, 0.03);
    source.stop(t + longest + 0.2);
    this.voices.push(voice);
  }

  noteOff(note, time) {
    if (this.params.mode !== 'gate') return;
    const voice = this.voices.findLast((v) => v.note === note && !v.released);
    if (voice) this.#release(voice, this.at(time), this.params.release);
  }

  allNotesOff(time) {
    const t = this.at(time);
    for (const voice of [...this.voices]) this.#release(voice, t, 0.005);
  }

  #release(voice, t, release) {
    voice.released = true;
    envRelease(voice.amp.gain, t, release);
    voice.source.stop(t + release * 2 + 0.05);
  }
}
