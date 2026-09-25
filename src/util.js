/** Time constant (s) for smoothing param changes, short enough to feel instant. */
export const SMOOTH = 0.01;

export const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);

/** MIDI note number → Hz (A4 = 69 = 440 Hz). */
export const mtof = (note) => 440 * 2 ** ((note - 69) / 12);

const SEMITONES = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

/**
 * Tracker note name → MIDI number: 'C-4' is 60, 'C#4' is 61. Returns null
 * for anything that isn't a note ('---', '===', '').
 */
export function parseNote(name) {
  const m = /^([A-G])([-#])(\d)$/.exec(name);
  if (!m) return null;
  return (Number(m[3]) + 1) * 12 + SEMITONES[m[1]] + (m[2] === '#' ? 1 : 0);
}

const NAMES = ['C-', 'C#', 'D-', 'D#', 'E-', 'F-', 'F#', 'G-', 'G#', 'A-', 'A#', 'B-'];

/** MIDI number → tracker note name, the inverse of parseNote: 61 is 'C#4'. */
export const noteName = (note) => NAMES[note % 12] + (Math.floor(note / 12) - 1);

/**
 * Seeded PRNG (mulberry32). Everything noisy is generated from this, so a
 * song renders the same on every play and every machine — which matters when
 * the visualizations are choreographed against it.
 */
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const noiseBuffers = new WeakMap();

/** Two seconds of seeded white noise, built once per AudioContext. */
export function noiseBuffer(ctx) {
  let buffer = noiseBuffers.get(ctx);
  if (!buffer) {
    const length = ctx.sampleRate * 2;
    buffer = ctx.createBuffer(1, length, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    const random = rng(0x5eed);
    for (let i = 0; i < length; i++) data[i] = random() * 2 - 1;
    noiseBuffers.set(ctx, buffer);
  }
  return buffer;
}

// ---- envelopes ---------------------------------------------------------------
//
// Built from setTargetAtTime, like an RC circuit: each stage chases its
// target exponentially and gets ~95% of the way there in the stage's length.
// The payoff is retriggering — a new stage starts from wherever the param
// actually is at that instant, with no need to know the current value ahead
// of time (which a lookahead scheduler can't).

const tc = (seconds) => Math.max(seconds / 3, 0.0005);

/** Attack to `peak`, then decay to `peak * sustain`. Cancels anything later. */
export function envStart(param, time, { attack, decay, sustain, peak = 1 }) {
  param.cancelScheduledValues(time);
  param.setTargetAtTime(peak, time, tc(attack));
  param.setTargetAtTime(peak * sustain, time + attack, tc(decay));
}

/** Release toward `floor`. Cancels anything later, including a pending decay. */
export function envRelease(param, time, release, floor = 0) {
  param.cancelScheduledValues(time);
  param.setTargetAtTime(floor, time, tc(release));
}

/**
 * One-shot percussive envelope on a fresh param: near-instant attack, then
 * decay. Returns when the sound has fallen ~50 dB, for stopping sources.
 */
export function envHit(param, time, peak, decay) {
  param.setValueAtTime(0, time);
  param.linearRampToValueAtTime(peak, time + 0.001);
  param.setTargetAtTime(0, time + 0.001, tc(decay));
  return time + 0.001 + decay * 2;
}
