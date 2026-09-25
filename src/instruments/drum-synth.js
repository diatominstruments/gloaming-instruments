import { Instrument, num } from '../module.js';
import { noiseBuffer, envHit } from '../util.js';

/** Note numbers for each drum, following General MIDI where it has one. */
export const DRUM = Object.freeze({
  KICK: 36,
  CLAP: 39,
  SNARE: 38,
  CLOSED_HAT: 42,
  OPEN_HAT: 46,
});

/**
 * DrumSynth — a synthesized kit, no samples needed: kick, snare, clap, and
 * closed/open hats (the closed hat chokes the open one). Notes other than
 * those in DRUM are ignored, and so is noteOff, since every hit is a
 * one-shot.
 */
export class DrumSynth extends Instrument {
  static id = 'drum-synth';
  static label = 'Drum Synth';
  static description = 'A synthesized kit: kick, snare, clap and hats, no samples needed.';
  static tags = ['drums', 'percussion'];
  static gated = false;
  static keys = {
    [DRUM.KICK]: 'Kick',
    [DRUM.SNARE]: 'Snare',
    [DRUM.CLAP]: 'Clap',
    [DRUM.CLOSED_HAT]: 'Closed hat',
    [DRUM.OPEN_HAT]: 'Open hat',
  };
  static params = {
    kickTune: num(30, 120, 48, {
      unit: 'Hz', primary: true, label: 'Tune', description: 'Pitch the kick settles to.',
    }),
    kickPunch: num(0, 1, 0.6, {
      unit: '%', label: 'Punch', description: 'Pitch sweep at the start of the hit.',
    }),
    kickDecay: num(0.05, 2, 0.45, {
      unit: 's', scale: 'log', primary: true, label: 'Decay', description: 'How long the kick booms.',
    }),
    snareTune: num(100, 400, 190, {
      unit: 'Hz', label: 'Tune', description: 'Pitch of the snare body.',
    }),
    snareSnap: num(0, 1, 0.7, {
      unit: '%', label: 'Snap', description: 'Noise rattle against the tuned body.',
    }),
    snareDecay: num(0.05, 1, 0.2, {
      unit: 's', scale: 'log', label: 'Decay', description: 'How long the snare rings.',
    }),
    clapDecay: num(0.05, 1, 0.25, {
      unit: 's', scale: 'log', label: 'Decay', description: 'Length of the clap tail.',
    }),
    hatTone: num(2000, 14000, 7000, {
      unit: 'Hz', scale: 'log', primary: true, label: 'Tone', description: 'Brightness of both hats.',
    }),
    hatDecay: num(0.01, 0.5, 0.05, {
      unit: 's', scale: 'log', label: 'Closed decay', description: 'Length of the closed hat.',
    }),
    openDecay: num(0.05, 2, 0.4, {
      unit: 's', scale: 'log', label: 'Open decay', description: 'Length of the open hat, unless a closed hat chokes it.',
    }),
    gain: num(0, 1, 0.8, { unit: '%', label: 'Level', description: 'Output level.' }),
  };
  static groups = [
    { id: 'kick', label: 'Kick', notes: [DRUM.KICK], params: ['kickTune', 'kickPunch', 'kickDecay'] },
    { id: 'snare', label: 'Snare', notes: [DRUM.SNARE], params: ['snareTune', 'snareSnap', 'snareDecay'] },
    { id: 'clap', label: 'Clap', notes: [DRUM.CLAP], params: ['clapDecay'] },
    {
      id: 'hats', label: 'Hats', notes: [DRUM.CLOSED_HAT, DRUM.OPEN_HAT],
      params: ['hatTone', 'hatDecay', 'openDecay'],
    },
    { id: 'output', label: 'Output', params: ['gain'] },
  ];
  static presets = {
    'Boom': { kickTune: 45, kickPunch: 0.4, kickDecay: 1.2, snareTune: 180, snareSnap: 0.6, hatTone: 8000 },
    'Tight': {
      kickPunch: 0.8, kickDecay: 0.25, snareSnap: 0.8, snareDecay: 0.12,
      clapDecay: 0.15, hatDecay: 0.03, openDecay: 0.25,
    },
    'Lo-fi': { kickTune: 55, kickPunch: 0.3, snareTune: 150, snareSnap: 0.5, hatTone: 4000, openDecay: 0.6 },
  };

  constructor(ctx, params) {
    super(ctx, params);
    this.sounding = new Set();   // amps still ringing, for allNotesOff
    this.openHat = null;         // the amp a closed hat chokes
  }

  noteOn(note, velocity = 1, time) {
    const t = this.at(time);
    switch (note) {
      case DRUM.KICK: return this.#kick(t, velocity);
      case DRUM.SNARE: return this.#snare(t, velocity);
      case DRUM.CLAP: return this.#clap(t, velocity);
      case DRUM.CLOSED_HAT: return this.#hat(t, velocity, false);
      case DRUM.OPEN_HAT: return this.#hat(t, velocity, true);
    }
  }

  allNotesOff(time) {
    const t = this.at(time);
    for (const amp of this.sounding) choke(amp, t);
  }

  #kick(t, v) {
    const p = this.params;
    const osc = new OscillatorNode(this.ctx, { type: 'sine' });
    osc.frequency.setValueAtTime(p.kickTune * (1 + p.kickPunch * 6), t);
    osc.frequency.setTargetAtTime(p.kickTune, t, 0.025);
    const amp = this.#amp();
    this.#play(osc, amp, t, envHit(amp.gain, t, v, p.kickDecay));
  }

  #snare(t, v) {
    const p = this.params;
    const body = new OscillatorNode(this.ctx, { type: 'triangle', frequency: p.snareTune });
    const bodyAmp = this.#amp();
    this.#play(body, bodyAmp, t, envHit(bodyAmp.gain, t, v * (1 - p.snareSnap * 0.7), p.snareDecay * 0.5));

    const snap = new BiquadFilterNode(this.ctx, { type: 'highpass', frequency: 1500 });
    const snapAmp = this.#amp();
    snap.connect(snapAmp);
    this.#play(this.#noise(snap), snapAmp, t, envHit(snapAmp.gain, t, v * p.snareSnap, p.snareDecay));
  }

  #clap(t, v) {
    const band = new BiquadFilterNode(this.ctx, { type: 'bandpass', frequency: 1200, Q: 1.5 });
    const amp = this.#amp();
    band.connect(amp);

    // A few ragged bursts, then the tail: the "many hands" of an 808 clap.
    const g = amp.gain;
    g.setValueAtTime(0, t);
    for (let k = 0; k < 3; k++) {
      g.setValueAtTime(v, t + k * 0.011);
      g.setTargetAtTime(0, t + k * 0.011, 0.003);
    }
    const tail = t + 0.033;
    this.#play(this.#noise(band), amp, t, envHit(g, tail, v * 0.8, this.params.clapDecay));
  }

  #hat(t, v, open) {
    const p = this.params;
    if (this.openHat) choke(this.openHat, t);

    const tone = new BiquadFilterNode(this.ctx, { type: 'highpass', frequency: p.hatTone, Q: 1 });
    const amp = this.#amp();
    tone.connect(amp);
    const end = envHit(amp.gain, t, v * 0.5, open ? p.openDecay : p.hatDecay);
    this.#play(this.#noise(tone), amp, t, end);
    this.openHat = open ? amp : null;
  }

  #amp() {
    const amp = new GainNode(this.ctx, { gain: 0 });
    amp.connect(this.output);
    return amp;
  }

  #noise(destination) {
    const src = new AudioBufferSourceNode(this.ctx, { buffer: noiseBuffer(this.ctx), loop: true });
    src.connect(destination);
    return src;
  }

  #play(source, amp, t, end) {
    if (!(source instanceof AudioBufferSourceNode)) source.connect(amp);
    this.sounding.add(amp);
    source.onended = () => {
      amp.disconnect();
      this.sounding.delete(amp);
      if (this.openHat === amp) this.openHat = null;
    };
    source.start(t);
    source.stop(end);
  }
}

function choke(amp, t) {
  amp.gain.cancelScheduledValues(t);
  amp.gain.setTargetAtTime(0, t, 0.004);
}
