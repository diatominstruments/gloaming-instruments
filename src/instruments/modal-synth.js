import { Instrument, num, choice } from '../module.js';
import { mtof, noiseBuffer, envRelease, clamp, rng } from '../util.js';

const MAX_VOICES = 12;
const STRIKE = 0.003;     // exciter burst length (s)
const BOW_NOISE = 10;     // length of the bow's noise loop (s)
const BOW = 0.6;          // a bowed mode's steady level, against a struck one's ring
const WARBLE_MODES = 4;   // how many of the lowest modes get a twin
// Levels of a warbling mode and its twin, 3:2, sharing the mode's power so
// that warble doesn't change loudness.
const TWIN = [0.6, 0.4].map((share) => share / Math.hypot(0.6, 0.4));
const SEED = 0x6d0da1;    // for humanise

/**
 * Chrome stops running a biquad soon after its input falls silent, going by
 * a tail estimate that's far too short at high Q (11 ms at Q 3000), which
 * cut every note off at about half a second. So the exciter never quite
 * closes: between strikes it idles here, about -180 dB, instead of at zero.
 */
const IDLE = 1e-9;

/**
 * Mode tables: each material is a list of partial frequencies as ratios of
 * the note's fundamental. They come from the physics of the shape — a free
 * bar's bending modes, the partial series of a bell — and are what makes
 * wood sound like wood and steel like steel. A tuned (marimba-style) bar
 * has its second partial shaved to a double octave. A membrane is an ideal
 * drum head, and a tine a bar clamped at one end, like a kalimba's.
 */
const MATERIALS = {
  wood:  [1, 3.93, 9.54, 16.3],
  glass: [1, 2.32, 3.86, 5.62, 7.58, 9.7],
  steel: [1, 2.76, 5.40, 8.93, 13.34, 18.64],
  bell:  [0.5, 1, 1.2, 1.5, 2, 2.51, 3, 4],
  membrane: [1, 1.594, 2.136, 2.296, 2.653, 2.918, 3.156, 3.501],
  tine:  [1, 6.267, 17.55, 34.39],
};

/**
 * A material's partials with `stretch` applied: each moves in log-frequency
 * toward (amount < 0) or away from (amount > 0) the same-numbered partial of
 * a harmonic series on the lowest one. At -1 every material is a plain
 * harmonic series, like a string.
 */
const stretched = (ratios, amount) => ratios.map((r, i) => r * (r / (ratios[0] * (i + 1))) ** amount);

/**
 * ModalSynth — struck and bowed bars, bowls, bells and drums. Each note is
 * a bank of high-Q bandpass filters, one per partial of the chosen
 * material, rung by noise: a few milliseconds of it for a strike, a steady
 * stream for a bow. `strike` is mallet hardness (a lowpass on the noise, so
 * soft mallets don't reach the upper partials), `decay` the fundamental's
 * ring time and `damping` how much faster the upper partials die away.
 * Harder hits are brighter as well as louder.
 *
 * `stretch` bends the material's partials toward or away from a harmonic
 * series, and `position` is where the mallet lands. `warble` splits each
 * low partial into a pair a few Hz apart, which beat like the split modes
 * of a real bell. `drop` starts the partials sharp and lets them settle,
 * like the pitch sag of a drum head; harder hits bend further.
 *
 * Every mode's gain is compensated for its Q, so changing `decay` doesn't
 * change loudness — a resonator with a longer ring is a quieter one, and
 * we make up the difference.
 *
 * In 'one-shot' mode noteOff is ignored and repeated strikes pile up, like
 * a real bar; in 'gate' mode noteOff damps the note over `release`. In
 * 'bow' mode the noise swells in over `attack` and plays until noteOff,
 * which damps the note over `release`.
 *
 * `humanise` varies each hit's hardness, position, level and noise a
 * little. The variation comes from a seeded generator that restarts at
 * allNotesOff, so a song sounds the same every time it's played from the
 * same point.
 */
export class ModalSynth extends Instrument {
  static id = 'modal-synth';
  /** v2: notes ring for their full decay in Chrome (see IDLE). */
  static version = 2;
  static label = 'Modal Synth';
  static description = 'Struck and bowed bars, bowls, bells and drums: a bank of resonators per note, rung by a mallet or a bow.';
  static tags = ['mallet', 'bell', 'percussion', 'pad'];
  static polyphony = MAX_VOICES;
  static gated = { mode: ['gate', 'bow'] };
  static params = {
    material: choice(Object.keys(MATERIALS), 'glass', {
      primary: true, label: 'Material', description: 'What is struck, which sets the pattern of overtones.',
      labels: { wood: 'Wood', glass: 'Glass', steel: 'Steel', bell: 'Bell', membrane: 'Membrane', tine: 'Tine' },
    }),
    mode: choice(['one-shot', 'gate', 'bow'], 'one-shot', {
      label: 'Mode',
      description: 'One-shot lets each strike ring out; gated damps it at note off; bowed sustains the note for as long as it is held.',
      labels: { 'one-shot': 'One-shot', gate: 'Gated', bow: 'Bowed' },
    }),
    strike: num(0, 1, 0.6, {
      unit: '%', label: 'Hardness', description: "Mallet hardness, or how bright the bow is: soft mallets don't reach the upper overtones.",
    }),
    position: num(0, 1, 0, {
      unit: '%', label: 'Position',
      description: 'Where the mallet lands: every overtone rings at the edge, and toward the centre alternate ones fall silent.',
    }),
    humanise: num(0, 1, 0, {
      unit: '%', label: 'Humanise', description: 'Small, repeatable changes to each hit, so repeated notes are never quite identical.',
    }),
    brightness: num(0, 1, 0.5, {
      unit: '%', label: 'Brightness', description: 'Level of the upper overtones against the fundamental.',
    }),
    stretch: num(-1, 1, 0, {
      center: 0, label: 'Stretch',
      description: 'Pulls the overtones toward a plain harmonic series, like a string, or pushes them further out.',
    }),
    decay: num(0.05, 10, 2, {
      unit: 's', scale: 'log', primary: true, label: 'Decay', description: 'Ring time of the fundamental.',
    }),
    damping: num(0, 1, 0.4, {
      unit: '%', label: 'Damping', description: 'How much faster the upper overtones die away.',
    }),
    warble: num(0, 8, 0, {
      unit: 'Hz', label: 'Warble', description: 'Beating in the lower overtones, like a real bell or singing bowl.',
    }),
    drop: num(0, 12, 0, {
      unit: 'st', label: 'Amount', description: 'How far above the note each hit starts before settling, like a drum head. Harder hits bend further.',
    }),
    dropTime: num(0.01, 2, 0.15, {
      unit: 's', scale: 'log', label: 'Time', description: 'How long the pitch takes to settle.',
    }),
    attack: num(0.005, 4, 0.2, {
      unit: 's', scale: 'log', activeWhen: { mode: 'bow' },
      label: 'Attack', description: 'How quickly the bow comes up to pressure. Longer decays also swell more slowly.',
    }),
    release: num(0.005, 8, 0.05, {
      unit: 's', scale: 'log', activeWhen: { mode: ['gate', 'bow'] },
      label: 'Release', description: 'How quickly a note is damped at note off.',
    }),
    gain: num(0, 1, 0.6, { unit: '%', label: 'Level', description: 'Output level.' }),
  };
  static groups = [
    { id: 'body', label: 'Body', params: ['material', 'stretch', 'decay', 'damping', 'brightness', 'warble'] },
    { id: 'mallet', label: 'Mallet', params: ['strike', 'position', 'humanise'] },
    { id: 'drop', label: 'Pitch drop', params: ['drop', 'dropTime'] },
    { id: 'note', label: 'Note', params: ['mode', 'attack', 'release'] },
    { id: 'output', label: 'Output', params: ['gain'] },
  ];
  static presets = {
    'Marimba': { material: 'wood', strike: 0.4, brightness: 0.4, decay: 0.8, damping: 0.5 },
    'Glass bowl': { material: 'glass', strike: 0.3, brightness: 0.6, decay: 6, damping: 0.2 },
    'Glockenspiel': { material: 'steel', strike: 0.8, brightness: 0.7, decay: 3, damping: 0.3 },
    'Church bell': { material: 'bell', strike: 0.7, brightness: 0.6, decay: 8, damping: 0.35 },
    'Singing bowl': {
      material: 'steel', mode: 'bow', attack: 1.5, release: 4, strike: 0.35, brightness: 0.55, decay: 8, damping: 0.3,
      warble: 1.2, gain: 0.45,
    },
    'Glass harmonica': {
      material: 'glass', mode: 'bow', attack: 0.3, release: 0.8, strike: 0.4, brightness: 0.3, decay: 2.5, damping: 0.6,
      warble: 0.4, gain: 0.4,
    },
    'Kalimba': { material: 'tine', strike: 0.55, brightness: 0.5, decay: 1.8, damping: 0.55, position: 0.2, humanise: 0.35 },
    'Hand drum': {
      material: 'membrane', strike: 0.5, brightness: 0.55, decay: 0.45, damping: 0.45, position: 0.35, humanise: 0.4,
      drop: 4, dropTime: 0.12,
    },
    'Steel pan': { material: 'glass', stretch: -0.85, strike: 0.6, brightness: 0.55, decay: 1.6, damping: 0.45, warble: 1.8 },
  };

  constructor(ctx, params) {
    super(ctx, params);
    this.voices = [];   // { note, amp, source, bowed, released }, in start order
    this.random = rng(SEED);
  }

  noteOn(note, velocity = 1, time) {
    const t = this.at(time);
    const p = this.params;
    const ctx = this.ctx;
    if (this.voices.length >= MAX_VOICES) this.#release(this.voices[0], t, 0.005);

    const hz = mtof(note);
    const fs = ctx.sampleRate;
    const nyquist = fs * 0.45;
    const bowed = p.mode === 'bow';

    // Humanise. Four draws for every note whatever the params, so the
    // sequence doesn't shift when they change. `position` may land outside
    // 0..1, but the comb below mirrors at both ends.
    const vary = () => (this.random() * 2 - 1) * p.humanise;
    velocity *= 1 - 0.25 * p.humanise * this.random();
    const strike = clamp(p.strike + 0.15 * vary(), 0, 1);
    const position = p.position + 0.15 * vary();
    const offset = (note * 0.0137 + p.humanise * this.random() * 1.9) % 1.9;

    // Noise, shaped by the mallet: a lowpass whose cutoff rises with
    // `strike` and with velocity. A strike is a short burst of it, a bow a
    // steady stream from a longer loop. A resonator fed a loop settles into
    // repeating it, and two seconds of repeats would be audible.
    const source = new AudioBufferSourceNode(ctx, { buffer: noiseBuffer(ctx, bowed ? BOW_NOISE : 2), loop: true });
    const exciter = new GainNode(ctx, { gain: 0 });
    const mallet = new BiquadFilterNode(ctx, {
      type: 'lowpass',
      frequency: 300 * 40 ** strike * (0.5 + 0.5 * velocity),
      Q: 0,
    });
    if (bowed) {
      exciter.gain.setTargetAtTime(1, t, p.attack / 3);
    } else {
      exciter.gain.setValueAtTime(1 / Math.sqrt(STRIKE * fs), t);
      exciter.gain.setValueAtTime(IDLE, t + STRIKE);
    }
    source.connect(exciter).connect(mallet);

    // The partials, stretched and then combed by `position`: the comb leaves
    // the fundamental alone, and its notches move down the series as the
    // mallet moves in from the edge, until at the centre every other partial
    // is gone. With `drop` each starts sharp, so must start below Nyquist.
    const bend = 2 ** ((p.drop * velocity) / 12);
    const tilt = (1 - p.brightness) * 2;
    const modes = stretched(MATERIALS[p.material], p.stretch)
      .map((ratio, i) => ({
        ratio,
        t60: p.decay * ratio ** (-p.damping * 2),
        level: Math.min(1, ratio ** -tilt) * Math.abs(Math.cos((Math.PI * i * position) / 2)),
      }))
      .filter(({ ratio, level }) => hz * ratio * bend < nyquist && level > 1e-4);
    const loudness = Math.sqrt(modes.reduce((sum, m) => sum + m.level ** 2, 0)) || 1;
    const amp = new GainNode(ctx, { gain: (0.5 * velocity) / loudness });
    amp.connect(this.output);

    // One resonator per partial. A bandpass biquad's impulse response peaks
    // at 2πf/(fs·Q), so a struck mode is scaled by the inverse to ring at
    // unit level, which makes the gain independent of frequency and decay.
    // With `drop` it rings up at its starting frequency, so that's the f.
    // Under steady noise it's the resonator's output power that counts,
    // which goes as its bandwidth f/Q, so a bowed mode is scaled by √(Q/f).
    // The voice is then trimmed by the modes' combined level, so a bell with
    // eight partials comes out as loud as a bar with four.
    //
    // With `warble`, each of the lowest modes is split into a pair, the twin
    // a few Hz up and quieter, so they beat without ever cancelling. The
    // split widens up the series so the partials don't all beat in step.
    const cents = 100 * p.drop * velocity;
    let longest = 0;
    for (const [i, { ratio, t60, level }] of modes.entries()) {
      const f = hz * ratio;
      const pair = p.warble > 0 && i < WARBLE_MODES
        ? [[f, TWIN[0]], [f + p.warble * Math.sqrt(ratio), TWIN[1]]]
        : [[f, 1]];
      for (const [freq, share] of pair) {
        const q = (Math.PI * freq * t60) / 6.9;
        const gain = bowed
          ? level * share * BOW * Math.sqrt((q * fs) / (Math.PI * freq))
          : (level * share * q * fs) / (2 * Math.PI * freq * bend);
        const filter = new BiquadFilterNode(ctx, { type: 'bandpass', frequency: freq, Q: q, detune: cents });
        if (cents) filter.detune.setTargetAtTime(0, t, p.dropTime / 3);
        mallet.connect(filter).connect(new GainNode(ctx, { gain })).connect(amp);
      }
      longest = Math.max(longest, t60);
    }

    // The source outlives the burst so its `onended` can tear the voice down
    // once the ring has faded. A bowed note plays until it's released.
    const voice = { note, amp, source, bowed, released: false };
    source.onended = () => {
      amp.disconnect();
      const i = this.voices.indexOf(voice);
      if (i >= 0) this.voices.splice(i, 1);
    };
    source.start(t, offset);
    if (!bowed) {
      amp.gain.setTargetAtTime(0, t + longest, 0.03);
      source.stop(t + longest + 0.2);
    }
    this.voices.push(voice);
  }

  noteOff(note, time) {
    // A bowed note always needs ending, even if the mode has since changed.
    const gated = this.params.mode !== 'one-shot';
    const voice = this.voices.findLast((v) => v.note === note && !v.released && (gated || v.bowed));
    if (voice) this.#release(voice, this.at(time), this.params.release);
  }

  allNotesOff(time) {
    const t = this.at(time);
    for (const voice of [...this.voices]) this.#release(voice, t, 0.005);
    this.random = rng(SEED);
  }

  #release(voice, t, release) {
    voice.released = true;
    envRelease(voice.amp.gain, t, release);
    voice.source.stop(t + release * 2 + 0.05);
  }
}
