// Sonidos del cuaderno. No hay archivos de audio: se generan en el momento con Web Audio
// (ruido filtrado y envolventes suaves), así que no pesan ni tienen licencia. Se pueden
// apagar desde Ajustes → Personalización.

export type SoundName = 'turn-next' | 'turn-prev' | 'type' | 'delete';

/** Números al azar en [0, 1). Se puede reemplazar para repetir un sonido idéntico. */
export type Random = () => number;

/** Un sonido en marcha. */
export interface Voice {
  /** Instante (en el reloj del contexto) en que termina de sonar. */
  readonly end: number;
  /** Lo apaga con una caída rápida, sin cortes bruscos. */
  fade(seconds?: number): void;
}

export interface RenderOptions {
  /** Instante de inicio, en segundos del contexto. */
  when?: number;
  /** Adónde va el sonido; por defecto, la salida del contexto. */
  destination?: AudioNode;
  random?: Random;
  /** Se llama cuando el sonido terminó y sus nodos ya se soltaron. */
  onEnd?: () => void;
}

/** Volumen general: los sonidos acompañan, no mandan. */
const DEFAULT_VOLUME = 0.8;
/** Cuántos sonidos pueden sonar a la vez; el más viejo se apaga para dejar lugar. */
const MAX_VOICES = 3;
/** Un sonido que tardó más que esto en poder arrancar ya no tiene sentido. */
const TOO_LATE = 0.3;
/** Sin sonar tanto tiempo, el contexto de audio se duerme para no tener la salida abierta. */
const IDLE = 20_000;
/** Casi silencio (−80 dB): las caídas exponenciales no pueden llegar a cero. */
const SILENCE = 0.0001;

let enabled = true;
let volume = DEFAULT_VOLUME;

/** Prende o apaga todos los sonidos. Al apagarlos se corta lo que esté sonando. */
export function setSoundsEnabled(on: boolean): void {
  enabled = on;
  if (!on) for (const entry of [...playing]) drop(entry, 0.03);
}

/** Volumen general, de 0 a 1. */
export function setSoundVolume(level: number): void {
  volume = Math.min(1, Math.max(0, Number.isFinite(level) ? level : DEFAULT_VOLUME));
  try {
    if (input && context) input.gain.setTargetAtTime(volume, context.currentTime, 0.02);
  } catch {
    // sin audio no hay volumen que cambiar
  }
}

/** Reproduce un sonido del cuaderno; no hace nada si están apagados ni si no hay audio. */
export function playSound(name: SoundName): void {
  if (!enabled) return;
  try {
    const ctx = audio();
    if (!ctx) return;
    if (ctx.state === 'running') {
      begin(ctx, name);
      return;
    }
    // Dormido (o aún despertando): se espera a que despierte, pero un sonido viejo se descarta.
    const asked = performance.now();
    ctx.resume().then(
      () => {
        if (enabled && performance.now() - asked < TOO_LATE * 1000) begin(ctx, name);
      },
      () => {},
    );
  } catch {
    // sin Web Audio el cuaderno sigue funcionando, solo que en silencio
  }
}

/** Cuántos sonidos están sonando ahora (sirve para comprobar que no se acumulan). */
export function soundsPlaying(): number {
  return playing.length;
}

// ---- reproducción en vivo -------------------------------------------------------------

interface Playing {
  /** Familia del sonido: dos hojas que se pasan seguidas no suenan una encima de la otra. */
  family: string;
  voice: Voice;
}

let context: AudioContext | null = null;
let input: GainNode | null = null;
let idleTimer = 0;
const playing: Playing[] = [];

/** El contexto de audio se crea con la primera reproducción, que siempre sigue a un gesto. */
function audio(): AudioContext | null {
  if (context?.state === 'closed') {
    context = null;
    input = null;
  }
  if (!context) {
    if (typeof AudioContext === 'undefined') return null;
    const created = new AudioContext({ latencyHint: 'interactive' });
    input = createSoundBus(created);
    context = created;
  }
  return context;
}

function begin(ctx: AudioContext, name: SoundName): void {
  window.clearTimeout(idleTimer);
  // Una hoja que se pasa reemplaza a la anterior, y teclear rápido no amontona pulsos viejos...
  const family = name.startsWith('turn') ? 'turn' : name === 'type' || name === 'delete' ? 'key' : name;
  if (family === 'turn' || family === 'key') for (const entry of [...playing]) if (entry.family === family) drop(entry, 0.02);
  // ...y nunca suenan más de unos pocos a la vez.
  while (playing.length >= MAX_VOICES) drop(playing[0], 0.05);
  const voice = renderSound(ctx, name, { destination: input ?? ctx.destination, onEnd: () => forget(voice) });
  playing.push({ family, voice });
}

function forget(voice: Voice): void {
  const at = playing.findIndex((entry) => entry.voice === voice);
  if (at >= 0) playing.splice(at, 1);
  if (playing.length === 0) sleepLater();
}

function drop(entry: Playing, seconds: number): void {
  const at = playing.indexOf(entry);
  if (at >= 0) playing.splice(at, 1);
  entry.voice.fade(seconds);
  if (playing.length === 0) sleepLater();
}

/** Si pasa un rato sin sonidos, duerme el contexto; el próximo sonido lo despierta. */
function sleepLater(): void {
  window.clearTimeout(idleTimer);
  idleTimer = window.setTimeout(() => {
    const ctx = context;
    if (!ctx || playing.length > 0 || ctx.state !== 'running') return;
    ctx.suspend().then(
      () => {
        // Si justo entró un sonido mientras se dormía, se lo despierta.
        if (playing.length > 0) void ctx.resume().catch(() => {});
      },
      () => {},
    );
  }, IDLE);
}

/**
 * Salida común de los sonidos: volumen general y un tope suave que evita que varios a la
 * vez lleguen a saturar. Devuelve la entrada; la salida va a `destination`.
 */
export function createSoundBus(ctx: BaseAudioContext, destination: AudioNode = ctx.destination): GainNode {
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(volume, 0);
  const shaper = ctx.createWaveShaper();
  shaper.curve = softClip();
  gain.connect(shaper);
  shaper.connect(destination);
  return gain;
}

let clipCurve: Float32Array<ArrayBuffer> | null = null;
/** Casi lineal para señales chicas; nunca pasa de ±0,8, por más fuerte que entre. */
function softClip(): Float32Array<ArrayBuffer> {
  if (!clipCurve) {
    const limit = 0.8;
    clipCurve = new Float32Array(2049);
    for (let i = 0; i < clipCurve.length; i++) {
      const x = (i / (clipCurve.length - 1)) * 2 - 1;
      clipCurve[i] = limit * Math.tanh(x / limit);
    }
  }
  return clipCurve;
}

// ---- ruido ------------------------------------------------------------------------------

const NOISE_RATE = 44100;
let noiseBuffer: AudioBuffer | null = null;

/** Dos segundos de ruido blanco, hechos una sola vez; cada sonido lee un tramo al azar. */
function whiteNoise(): AudioBuffer {
  if (!noiseBuffer) {
    const length = NOISE_RATE * 2;
    const buffer = new AudioBuffer({ length, sampleRate: NOISE_RATE });
    const data = buffer.getChannelData(0);
    for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
    noiseBuffer = buffer;
  }
  return noiseBuffer;
}

// ---- piezas para armar un sonido --------------------------------------------------------

interface Glide {
  to: number;
  when: number;
  seconds: number;
}

interface Crackle {
  /** Banda en la que cae el centro de cada crujido (al azar entre `low` y `high`). */
  low: number;
  high: number;
  q: number;
  peak: number;
  /** Largo de cada crujido y pausa entre uno y otro, en segundos. */
  len: [number, number];
  gap: [number, number];
  /** Cuánto se apagan hacia el final (0 = nada) y cuánto se espacian. */
  fade: number;
  spread: number;
}

/** Un sonido en construcción: lleva la cuenta de sus nodos para soltarlos al terminar. */
class Patch {
  /** Adonde se conectan todas las capas del sonido. */
  readonly out: GainNode;
  end = 0;
  private readonly nodes: AudioNode[] = [];
  private readonly sources: AudioScheduledSourceNode[] = [];
  private readonly panner: StereoPannerNode | null;
  private running = 0;
  private faded = false;
  private readonly ctx: BaseAudioContext;
  private readonly random: Random;
  private readonly onEnd: () => void;

  constructor(ctx: BaseAudioContext, random: Random, destination: AudioNode, onEnd: () => void) {
    this.ctx = ctx;
    this.random = random;
    this.onEnd = onEnd;
    this.out = this.add(ctx.createGain());
    // Nada pasa de unos 9 kHz: el ruido blanco de arriba solo agrega siseo.
    const soften = this.filter('lowpass', 9000, 0.5);
    this.panner = typeof ctx.createStereoPanner === 'function' ? this.add(ctx.createStereoPanner()) : null;
    this.chain(this.out, soften);
    if (this.panner) {
      soften.connect(this.panner);
      this.panner.connect(destination);
    } else {
      soften.connect(destination);
    }
  }

  /** Número al azar entre `a` y `b`. */
  between(a: number, b: number): number {
    return a + (b - a) * this.random();
  }

  /** `x` con una variación de hasta ±`spread` (0,1 = ±10 %). */
  vary(x: number, spread: number): number {
    return x * (1 + (this.random() * 2 - 1) * spread);
  }

  /** Volumen de todo el sonido. */
  level(value: number): void {
    this.out.gain.setValueAtTime(value, 0);
  }

  /** Ruido blanco entre `when` y `when + seconds`, tomado de un punto cualquiera del búfer. */
  noise(when: number, seconds: number): AudioBufferSourceNode {
    const source = this.track(this.ctx.createBufferSource());
    const buffer = whiteNoise();
    source.buffer = buffer;
    source.start(when, this.random() * Math.max(0, buffer.duration - seconds - 0.01), seconds);
    this.end = Math.max(this.end, when + seconds);
    return source;
  }

  /** Tono senoidal que se desliza de `from` a `to`. */
  tone(when: number, seconds: number, from: number, to = from): OscillatorNode {
    const osc = this.track(this.ctx.createOscillator());
    osc.frequency.setValueAtTime(from, when);
    if (to !== from) osc.frequency.exponentialRampToValueAtTime(to, when + seconds);
    osc.start(when);
    osc.stop(when + seconds);
    this.end = Math.max(this.end, when + seconds);
    return osc;
  }

  gain(value = 1): GainNode {
    const node = this.add(this.ctx.createGain());
    node.gain.value = value;
    return node;
  }

  /** Filtro fijo, o que se desliza hacia otra frecuencia. */
  filter(type: BiquadFilterType, frequency: number, q: number, glide?: Glide): BiquadFilterNode {
    const node = this.add(this.ctx.createBiquadFilter());
    node.type = type;
    node.Q.value = q;
    node.frequency.value = frequency;
    if (glide) {
      node.frequency.setValueAtTime(frequency, glide.when);
      node.frequency.exponentialRampToValueAtTime(glide.to, glide.when + glide.seconds);
    }
    return node;
  }

  /** Conecta los nodos uno tras otro. */
  chain(...nodes: AudioNode[]): void {
    for (let i = 0; i < nodes.length - 1; i++) nodes[i].connect(nodes[i + 1]);
  }

  /** Volumen que sube suave (coseno) hasta `peak` en `attack`, y cae hasta cero en `release`. */
  swell(when: number, peak: number, attack: number, release: number): GainNode {
    const node = this.gain(0);
    const points = 96;
    const total = attack + release;
    const curve = new Float32Array(points);
    for (let i = 0; i < points; i++) {
      const s = (i / (points - 1)) * total;
      if (s < attack) {
        curve[i] = peak * (0.5 - 0.5 * Math.cos((Math.PI * s) / attack));
      } else {
        const x = (s - attack) / release;
        const edge = Math.min(1, Math.max(0, (x - 0.7) / 0.3));
        curve[i] = peak * Math.exp(-4.5 * x) * (1 - edge * edge * (3 - 2 * edge));
      }
    }
    node.gain.setValueCurveAtTime(curve, when, total);
    this.end = Math.max(this.end, when + total);
    return node;
  }

  /** Volumen de golpe: sube en un instante y cae exponencial hasta el silencio. */
  hit(when: number, peak: number, decay: number, attack = 0.002): GainNode {
    const node = this.gain(0);
    const param = node.gain;
    param.setValueAtTime(0, when);
    param.linearRampToValueAtTime(peak, when + attack);
    param.exponentialRampToValueAtTime(SILENCE, when + attack + decay);
    param.linearRampToValueAtTime(0, when + attack + decay + 0.005);
    this.end = Math.max(this.end, when + attack + decay + 0.005);
    return node;
  }

  /** Paneo que va de `from` a `to` (−1 izquierda, 1 derecha). */
  drift(when: number, seconds: number, from: number, to: number): void {
    if (!this.panner) return;
    this.panner.pan.setValueAtTime(from, when);
    this.panner.pan.linearRampToValueAtTime(to, when + seconds);
  }

  /** Crujidos sueltos (fibras, cartón, papel que se arruga) repartidos en `span` segundos. */
  crackle(when: number, span: number, o: Crackle): void {
    const band = this.filter('bandpass', o.low, o.q);
    const amp = this.gain(0);
    this.chain(this.noise(when, span + 0.05), band, amp, this.out);
    let t = 0.002;
    while (t < span) {
      const at = when + t;
      const len = Math.max(0.008, Math.min(this.between(o.len[0], o.len[1]), span - t));
      // Las bandas agudas son más anchas y suenan más fuerte: se compensa para que no salten.
      const center = o.low * (o.high / o.low) ** this.random();
      const peak = o.peak * this.between(0.5, 1) * Math.exp((-o.fade * t) / span) * Math.sqrt(Math.sqrt(o.low * o.high) / center);
      band.frequency.setValueAtTime(center, at);
      amp.gain.setValueAtTime(0, at);
      amp.gain.linearRampToValueAtTime(peak, at + 0.004);
      amp.gain.exponentialRampToValueAtTime(SILENCE, at + len);
      t += len + this.between(o.gap[0], o.gap[1]) * (1 + (o.spread * t) / span);
    }
  }

  /** Cierra el sonido: de acá en más solo puede apagarse o terminar. */
  voice(): Voice {
    const end = this.end;
    return {
      end,
      fade: (seconds = 0.04) => {
        if (this.faded) return;
        this.faded = true;
        const now = this.ctx.currentTime;
        this.out.gain.setTargetAtTime(0, now, seconds / 6);
        for (const source of this.sources) {
          try {
            source.stop(now + seconds * 1.5);
          } catch {
            // ya había terminado: no hay nada que cortar
          }
        }
      },
    };
  }

  private add<T extends AudioNode>(node: T): T {
    this.nodes.push(node);
    return node;
  }

  private track<T extends AudioScheduledSourceNode>(source: T): T {
    this.sources.push(source);
    this.running++;
    source.onended = () => this.release();
    return this.add(source);
  }

  /** Cuando termina la última fuente se sueltan todos los nodos. */
  private release(): void {
    if (--this.running > 0) return;
    for (const node of this.nodes) {
      try {
        node.disconnect();
      } catch {
        // ya estaba suelto
      }
    }
    this.onEnd();
  }
}

// ---- los sonidos --------------------------------------------------------------------------

type Recipe = (p: Patch, t: number) => void;

/**
 * Una hoja que pasa: roce suave de papel con el aire y despegue de fibras orgánico.
 * Corto, suave y sin pitidos artificiales.
 */
function turn(p: Patch, t: number, dir: 1 | -1): void {
  const pitch = p.vary(1, 0.08);
  const d = p.vary(1, 0.1);
  const fly = 0.15 * d;
  const [from, to] = dir > 0 ? [1400, 2600] : [2600, 1400];
  p.level(0.68 * p.vary(1, 0.12));
  p.crackle(t, 0.04 * d, {
    low: 2000 * pitch,
    high: 4200 * pitch,
    q: 2,
    peak: 0.07,
    len: [0.003, 0.008],
    gap: [0.004, 0.01],
    fade: 0.6,
    spread: 0.4,
  });
  p.chain(
    p.noise(t, fly),
    p.filter('bandpass', from * pitch, 0.9, { to: to * pitch, when: t, seconds: fly }),
    p.swell(t, 0.45, 0.04 * d, 0.11 * d),
    p.out,
  );
  p.chain(p.noise(t, fly), p.filter('lowpass', 550 * pitch, 0.6), p.swell(t, 0.15, 0.05 * d, 0.1 * d), p.out);
  const land = t + 0.12 * d;
  p.chain(p.noise(land, 0.07), p.filter('bandpass', 1100 * pitch, 1.2), p.hit(land, 0.24, 0.05), p.out);
  p.drift(t, fly + 0.05, 0.15 * dir, -0.2 * dir);
}

/** Pulso táctil suave de escritura (~18-22 ms): tacto de papel y toque grave discreto. */
function keyType(p: Patch, t: number): void {
  const pitch = p.vary(1, 0.08);
  const dur = 0.02; // ~20 ms
  p.level(0.28 * p.vary(1, 0.1));
  p.chain(
    p.noise(t, dur),
    p.filter('bandpass', 2200 * pitch, 1.2),
    p.hit(t, 0.6, dur - 0.003, 0.002),
    p.out,
  );
  p.chain(
    p.noise(t, dur * 0.8),
    p.filter('lowpass', 380 * pitch, 0.7),
    p.hit(t, 0.35, dur * 0.7, 0.002),
    p.out,
  );
}

/** Borrado: pulso similar a escribir pero más grave y opaco (~25 ms). */
function keyDelete(p: Patch, t: number): void {
  const pitch = p.vary(1, 0.08);
  const dur = 0.025; // ~25 ms
  p.level(0.28 * p.vary(1, 0.1));
  p.chain(
    p.noise(t, dur),
    p.filter('bandpass', 1400 * pitch, 1.0),
    p.hit(t, 0.55, dur - 0.003, 0.002),
    p.out,
  );
  p.chain(
    p.noise(t, dur),
    p.filter('lowpass', 280 * pitch, 0.7),
    p.hit(t, 0.4, dur * 0.8, 0.002),
    p.out,
  );
}

const RECIPES: Record<SoundName, Recipe> = {
  'turn-next': (p, t) => turn(p, t, 1),
  'turn-prev': (p, t) => turn(p, t, -1),
  type: keyType,
  delete: keyDelete,
};

export function playKeySound(event: {
  key: string;
  ctrlKey?: boolean;
  altKey?: boolean;
  metaKey?: boolean;
}): void {
  if (event.key === 'Backspace' || event.key === 'Delete') {
    playSound('delete');
  } else if (
    (event.key.length === 1 || event.key === 'Enter' || event.key === 'Tab') &&
    !event.ctrlKey &&
    !event.altKey &&
    !event.metaKey
  ) {
    playSound('type');
  }
}

/**
 * Arma un sonido en cualquier contexto (también fuera de línea, para medirlo). Cada vez sale
 * un poco distinto: tono, duración y volumen varían al azar.
 */
export function renderSound(ctx: BaseAudioContext, name: SoundName, options: RenderOptions = {}): Voice {
  const patch = new Patch(ctx, options.random ?? Math.random, options.destination ?? ctx.destination, options.onEnd ?? (() => {}));
  RECIPES[name](patch, options.when ?? 0);
  return patch.voice();
}
