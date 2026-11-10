import { BlockId } from "../world/blocks";

/** Every sound in the game, synthesized on the fly with the Web Audio API:
 * shaped bursts of filtered noise for footsteps, digging and splashes, a
 * few oscillators for chimes, and a wind-and-wildlife bed that follows the
 * time of day. No audio files ship — like the textures, it's all code. */

export type SoundMaterial = "stone" | "soil" | "sand" | "wood" | "leaf" | "glass" | "snow";

const MATERIAL: Partial<Record<BlockId, SoundMaterial>> = {
  [BlockId.GRASS]: "soil",
  [BlockId.DIRT]: "soil",
  [BlockId.CLAY]: "soil",
  [BlockId.FROSTED_GRASS]: "snow",
  [BlockId.SNOW]: "snow",
  [BlockId.SAND]: "sand",
  [BlockId.GRAVEL]: "sand",
  [BlockId.WOOD]: "wood",
  [BlockId.PALE_WOOD]: "wood",
  [BlockId.PINE_WOOD]: "wood",
  [BlockId.PLANKS]: "wood",
  [BlockId.CACTUS]: "wood",
  [BlockId.LEAVES]: "leaf",
  [BlockId.AUTUMN_LEAVES]: "leaf",
  [BlockId.PINE_LEAVES]: "leaf",
  [BlockId.TALL_GRASS]: "leaf",
  [BlockId.FLOWER_RED]: "leaf",
  [BlockId.FLOWER_YELLOW]: "leaf",
  [BlockId.FLOWER_BLUE]: "leaf",
  [BlockId.DRY_BUSH]: "leaf",
  [BlockId.GLOWSHROOM]: "leaf",
  [BlockId.GLASS]: "glass",
  [BlockId.ICE]: "glass",
  [BlockId.CRYSTAL]: "glass",
  [BlockId.LANTERN]: "glass",
};

export function soundMaterialFor(id: BlockId): SoundMaterial {
  return MATERIAL[id] ?? "stone";
}

interface Voice {
  /** Band-pass center frequency and sharpness of the noise burst. */
  readonly frequency: number;
  readonly q: number;
  readonly duration: number;
  readonly gain: number;
}

const VOICES: Record<SoundMaterial, Voice> = {
  stone: { frequency: 1500, q: 1.1, duration: 0.11, gain: 0.5 },
  soil: { frequency: 520, q: 0.8, duration: 0.14, gain: 0.55 },
  sand: { frequency: 2600, q: 0.6, duration: 0.17, gain: 0.34 },
  wood: { frequency: 760, q: 2.6, duration: 0.12, gain: 0.6 },
  leaf: { frequency: 3800, q: 0.7, duration: 0.14, gain: 0.26 },
  glass: { frequency: 4600, q: 5, duration: 0.2, gain: 0.34 },
  snow: { frequency: 1100, q: 0.5, duration: 0.18, gain: 0.34 },
};

export interface Ambience {
  /** 0 by day, 1 at night. */
  readonly night: number;
  readonly underwater: boolean;
  /** 0 in the open, 1 deep underground. */
  readonly cave: number;
  /** How fast the player is moving through the air, blocks per second. */
  readonly speed: number;
}

export class SoundEngine {
  private context: AudioContext | null = null;
  private master: GainNode | null = null;
  private effects: BiquadFilterNode | null = null;
  private noise: AudioBuffer | null = null;
  private wind: { gain: GainNode; filter: BiquadFilterNode } | null = null;
  private volume = 0.7;
  private nextChirp = 0;
  private nextCricket = 0;

  /** Browsers only allow audio after a user gesture: call this from the
   * click that starts the game. Safe to call repeatedly. */
  unlock(): void {
    if (this.context) {
      if (this.context.state === "suspended") void this.context.resume();
      return;
    }
    const Ctor = window.AudioContext as typeof AudioContext | undefined;
    if (!Ctor) return;
    try {
      const context = new Ctor();
      const master = context.createGain();
      master.gain.value = this.volume;
      master.connect(context.destination);
      // Everything passes through one low-pass, closed down underwater.
      const effects = context.createBiquadFilter();
      effects.type = "lowpass";
      effects.frequency.value = 20000;
      effects.connect(master);

      const noise = context.createBuffer(1, context.sampleRate, context.sampleRate);
      const samples = noise.getChannelData(0);
      for (let i = 0; i < samples.length; i++) samples[i] = Math.random() * 2 - 1;

      const windSource = context.createBufferSource();
      windSource.buffer = noise;
      windSource.loop = true;
      const windFilter = context.createBiquadFilter();
      windFilter.type = "bandpass";
      windFilter.frequency.value = 420;
      windFilter.Q.value = 0.4;
      const windGain = context.createGain();
      windGain.gain.value = 0;
      windSource.connect(windFilter).connect(windGain).connect(effects);
      windSource.start();

      this.context = context;
      this.master = master;
      this.effects = effects;
      this.noise = noise;
      this.wind = { gain: windGain, filter: windFilter };
    } catch {
      this.context = null; // no audio device: the game is simply silent
    }
  }

  setVolume(volume: number): void {
    this.volume = volume;
    if (this.master && this.context) {
      this.master.gain.setTargetAtTime(volume, this.context.currentTime, 0.05);
    }
  }

  /** Silence while the menu is up or the tab is hidden. */
  setPaused(paused: boolean): void {
    if (!this.context) return;
    if (paused && this.context.state === "running") void this.context.suspend();
    else if (!paused && this.context.state === "suspended") void this.context.resume();
  }

  private burst(voice: Voice, pitch: number, gain: number, delay = 0): void {
    const { context, effects, noise } = this;
    if (!context || !effects || !noise) return;
    const start = context.currentTime + delay;
    const source = context.createBufferSource();
    source.buffer = noise;
    source.playbackRate.value = 0.7 + Math.random() * 0.6;
    const filter = context.createBiquadFilter();
    filter.type = "bandpass";
    filter.frequency.value = voice.frequency * pitch * (0.85 + Math.random() * 0.3);
    filter.Q.value = voice.q;
    const envelope = context.createGain();
    envelope.gain.setValueAtTime(0, start);
    envelope.gain.linearRampToValueAtTime(voice.gain * gain, start + 0.006);
    envelope.gain.exponentialRampToValueAtTime(0.0008, start + voice.duration);
    source.connect(filter).connect(envelope).connect(effects);
    source.start(start, Math.random() * 0.5, voice.duration + 0.05);
  }

  private tone(
    frequency: number,
    duration: number,
    gain: number,
    type: OscillatorType = "sine",
    glide = 1,
    delay = 0,
  ): void {
    const { context, effects } = this;
    if (!context || !effects) return;
    const start = context.currentTime + delay;
    const osc = context.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(frequency, start);
    if (glide !== 1)
      osc.frequency.exponentialRampToValueAtTime(frequency * glide, start + duration);
    const envelope = context.createGain();
    envelope.gain.setValueAtTime(0, start);
    envelope.gain.linearRampToValueAtTime(gain, start + 0.008);
    envelope.gain.exponentialRampToValueAtTime(0.0008, start + duration);
    osc.connect(envelope).connect(effects);
    osc.start(start);
    osc.stop(start + duration + 0.02);
  }

  step(block: BlockId): void {
    this.burst(VOICES[soundMaterialFor(block)], 0.8, 0.45);
  }

  breakBlock(block: BlockId): void {
    const material = soundMaterialFor(block);
    const voice = VOICES[material];
    this.burst(voice, 0.9, 1);
    this.burst(voice, 0.55, 0.7, 0.03);
    if (material === "glass") {
      this.tone(2400 + Math.random() * 900, 0.25, 0.08, "triangle", 0.7);
      this.tone(3600 + Math.random() * 900, 0.2, 0.05, "sine", 0.8, 0.02);
    }
  }

  placeBlock(block: BlockId): void {
    const voice = VOICES[soundMaterialFor(block)];
    this.burst(voice, 0.6, 0.85);
    this.tone(150, 0.07, 0.16, "sine", 0.6);
  }

  jump(): void {
    this.burst(VOICES.soil, 0.6, 0.22);
  }

  land(fallSpeed: number, block: BlockId): void {
    const strength = Math.min(1.4, fallSpeed / 14);
    this.burst(VOICES[soundMaterialFor(block)], 0.55, 0.5 + strength * 0.5);
    this.tone(90, 0.12, 0.2 * strength, "sine", 0.5);
  }

  splash(entering: boolean): void {
    this.burst({ frequency: 1400, q: 0.4, duration: 0.42, gain: 0.5 }, 1, entering ? 1 : 0.5);
    this.burst({ frequency: 520, q: 0.6, duration: 0.3, gain: 0.4 }, 1, entering ? 0.9 : 0.4, 0.03);
  }

  click(): void {
    this.tone(880, 0.05, 0.06, "triangle", 1.25);
  }

  select(): void {
    this.tone(620, 0.04, 0.045, "triangle", 1.15);
  }

  /** Call every frame: steers the wind and schedules wildlife. */
  update(ambience: Ambience): void {
    const { context, effects, wind } = this;
    if (!context || !effects || !wind || context.state !== "running") return;
    const now = context.currentTime;

    effects.frequency.setTargetAtTime(ambience.underwater ? 520 : 20000, now, 0.08);

    // Wind: a steady breath outdoors that rises with speed and nearly
    // vanishes underground; underwater it becomes a low rumble.
    const open = 1 - ambience.cave;
    const rush = Math.min(1, ambience.speed / 26);
    const level = ambience.underwater ? 0.22 : 0.035 * open + 0.012 + rush * 0.2;
    wind.gain.gain.setTargetAtTime(level, now, 0.4);
    wind.filter.frequency.setTargetAtTime(
      ambience.underwater ? 160 : 380 + rush * 900 + Math.sin(now * 0.23) * 90,
      now,
      0.5,
    );

    if (ambience.underwater || ambience.cave > 0.5) return;

    // Birdsong by day: a couple of quick rising or falling whistles.
    if (ambience.night < 0.35 && now >= this.nextChirp) {
      const base = 2200 + Math.random() * 1800;
      const notes = 2 + Math.floor(Math.random() * 3);
      for (let i = 0; i < notes; i++) {
        this.tone(
          base * (1 + i * 0.08 * (Math.random() < 0.5 ? 1 : -1)),
          0.09,
          0.018 + Math.random() * 0.014,
          "sine",
          Math.random() < 0.5 ? 1.25 : 0.8,
          i * 0.11,
        );
      }
      this.nextChirp = now + 2.5 + Math.random() * 7;
    }

    // Crickets by night: a short pulsed trill.
    if (ambience.night > 0.65 && now >= this.nextCricket) {
      const pitch = 4100 + Math.random() * 500;
      for (let i = 0; i < 5; i++) this.tone(pitch, 0.035, 0.011, "square", 1, i * 0.055);
      this.nextCricket = now + 0.7 + Math.random() * 2.2;
    }
  }
}
