// Imágenes pegadas en la tapa y en la contratapa, como calcomanías.
//
// Lo liviano (en qué cara va cada una, dónde, de qué tamaño y con qué giro) se guarda en
// localStorage, que avisa a las otras ventanas con el evento `storage`, igual que las
// preferencias: lo que se cambia en Ajustes se ve en el cuaderno al instante. Los píxeles
// van a IndexedDB, que no tiene el límite de tamaño de localStorage. Todo está dentro de
// try/catch: si el almacenamiento falla, el cuaderno sigue andando sin imágenes.
import { useEffect, useState, useSyncExternalStore } from 'react';
import { mark, t } from '../i18n';

/** Las dos caras del cuaderno cerrado. */
export type Face = 'front' | 'back';

export interface Sticker {
  id: string;
  face: Face;
  /** Centro de la imagen, como fracción del ancho y del alto de la tapa (0 a 1). */
  x: number;
  y: number;
  /** Ancho, como fracción del ancho de la tapa: al cambiar el tamaño del cuaderno, acompaña. */
  width: number;
  /** Alto sobre ancho de la imagen. */
  ratio: number;
  /** Giro, en grados. */
  turn: number;
  /** Las de número más alto van encima. */
  order: number;
}

/** Lo que se cambia al acomodar una imagen. */
export type Placement = Pick<Sticker, 'x' | 'y' | 'width' | 'turn'>;

const KEY = 'book.stickers';
const DATABASE = 'book-stickers';
const STORE = 'images';
/** Cuántas imágenes entran en cada cara. */
export const MAX_PER_FACE = 12;
/** Al importar, la imagen se reduce hasta que su lado mayor mida esto, en píxeles. */
const MAX_SIDE = 1024;
/** Un archivo más pesado que esto no se intenta abrir. */
const MAX_BYTES = 40 * 1024 * 1024;
/** Entre qué anchos se puede dejar una imagen, como fracción del ancho de la tapa. */
export const WIDTH = { min: 0.06, max: 3 };
/** Ancho sobre alto de la tapa (layout.ts): para saber cuánto ocupa una imagen a lo alto. */
const COVER_RATIO = 0.76;

export const FACE_NAME: Record<Face, string> = { front: mark('la tapa'), back: mark('la contratapa') };

/** Lo que no se pudo hacer, dicho para quien usa el cuaderno. */
export class StickerError extends Error {}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const isNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

/** Giro llevado a (−180, 180]. */
export const normalTurn = (degrees: number) => {
  const turned = ((degrees % 360) + 360) % 360;
  return turned > 180 ? turned - 360 : turned;
};

/** Deja una posición dentro de lo permitido: el centro no sale de la tapa. */
export function fitPlacement<T extends Placement>(sticker: T): T {
  return {
    ...sticker,
    x: clamp(sticker.x, 0, 1),
    y: clamp(sticker.y, 0, 1),
    width: clamp(sticker.width, WIDTH.min, WIDTH.max),
    turn: Math.round(normalTurn(sticker.turn) * 10) / 10,
  };
}

// ---- dónde va cada imagen (localStorage) -------------------------------------------

function parse(raw: string | null): Sticker[] {
  try {
    const saved: unknown = JSON.parse(raw ?? '[]');
    if (!Array.isArray(saved)) return [];
    const seen = new Set<string>();
    return saved.flatMap((item: Partial<Sticker> | null) => {
      if (!item || typeof item.id !== 'string' || !item.id || seen.has(item.id)) return [];
      if (!isNumber(item.x) || !isNumber(item.y) || !isNumber(item.width) || !isNumber(item.ratio) || item.ratio <= 0) return [];
      seen.add(item.id);
      return [
        fitPlacement({
          id: item.id,
          face: item.face === 'back' ? 'back' : 'front',
          x: item.x,
          y: item.y,
          width: item.width,
          ratio: clamp(item.ratio, 0.02, 50),
          turn: isNumber(item.turn) ? item.turn : 0,
          order: isNumber(item.order) ? item.order : 0,
        }),
      ];
    });
  } catch {
    return [];
  }
}

let cache: Sticker[] | null = null;
const listeners = new Set<() => void>();

function snapshot(): Sticker[] {
  if (cache) return cache;
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(KEY);
  } catch {
    // sin almacenamiento no hay imágenes guardadas
  }
  cache = parse(raw);
  return cache;
}

function write(next: Sticker[]) {
  // El orden se renumera por cara: no crece sin fin con cada imagen que se trae al frente.
  const rank = new Map<string, number>();
  for (const face of ['front', 'back'] as const) {
    next
      .filter((sticker) => sticker.face === face)
      .sort((a, b) => a.order - b.order)
      .forEach((sticker, index) => rank.set(sticker.id, index + 1));
  }
  cache = next.map((sticker) => (sticker.order === rank.get(sticker.id) ? sticker : { ...sticker, order: rank.get(sticker.id) ?? 1 }));
  try {
    localStorage.setItem(KEY, JSON.stringify(cache));
  } catch {
    // sin almacenamiento disponible, las imágenes duran lo que dure la ventana
  }
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

// Otra ventana (Ajustes, o el cuaderno) cambió las imágenes: acá se ven al instante.
window.addEventListener('storage', (event) => {
  if (event.key !== KEY && event.key !== null) return;
  cache = null;
  const kept = new Set(snapshot().map((sticker) => sticker.id));
  for (const id of [...images.keys()]) if (!kept.has(id)) images.delete(id);
  listeners.forEach((listener) => listener());
});

/** Todas las imágenes pegadas, de las dos caras. */
export function useStickers(): Sticker[] {
  return useSyncExternalStore(subscribe, snapshot);
}

/** Las de una cara, de la de más abajo a la de más arriba. */
export const stickersOn = (stickers: Sticker[], face: Face) => stickers.filter((sticker) => sticker.face === face).sort((a, b) => a.order - b.order);

// ---- los píxeles (IndexedDB) -------------------------------------------------------

let opening: Promise<IDBDatabase> | null = null;

function database(): Promise<IDBDatabase> {
  if (opening) return opening;
  const attempt = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB no abrió'));
    request.onblocked = () => reject(new Error('IndexedDB está ocupada'));
  });
  opening = attempt;
  // Si no abrió, la próxima vez se vuelve a intentar.
  attempt.catch(() => {
    if (opening === attempt) opening = null;
  });
  return attempt;
}

async function store<T>(mode: IDBTransactionMode, work: (images: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await database();
  return new Promise<T>((resolve, reject) => {
    const transaction = db.transaction(STORE, mode);
    const request = work(transaction.objectStore(STORE));
    transaction.oncomplete = () => resolve(request.result);
    transaction.onerror = () => reject(transaction.error ?? request.error ?? new Error('IndexedDB falló'));
    transaction.onabort = transaction.onerror;
  });
}

/**
 * Imágenes ya leídas, como direcciones `data:`: es lo que la política de contenido de la
 * app deja mostrar en un `<img>` (las direcciones `blob:` no pasan).
 */
const images = new Map<string, string>();
const reading = new Map<string, Promise<string | null>>();

function readImage(id: string): Promise<string | null> {
  const known = images.get(id);
  if (known) return Promise.resolve(known);
  let pending = reading.get(id);
  if (!pending) {
    pending = store<unknown>('readonly', (all) => all.get(id))
      .then((found) => {
        if (typeof found === 'string' && found.startsWith('data:image/')) {
          images.set(id, found);
          return found;
        }
        // Quedó anotada una imagen que no está: no se la sigue esperando.
        forget([id]);
        return null;
      })
      .catch(() => null)
      .finally(() => reading.delete(id));
    reading.set(id, pending);
  }
  return pending;
}

/** La imagen de una calcomanía, lista para un `<img>`; `null` mientras se lee o si no está. */
export function useStickerImage(id: string): string | null {
  const [url, setUrl] = useState<string | null>(() => images.get(id) ?? null);
  useEffect(() => {
    let alive = true;
    setUrl(images.get(id) ?? null);
    void readImage(id).then((found) => alive && setUrl(found));
    return () => {
      alive = false;
    };
  }, [id]);
  return url;
}

/** Saca del registro imágenes que ya no se van a mostrar. */
function forget(ids: string[]) {
  const gone = new Set(ids);
  ids.forEach((id) => images.delete(id));
  const current = snapshot();
  if (current.some((sticker) => gone.has(sticker.id))) write(current.filter((sticker) => !gone.has(sticker.id)));
}

/** Decodifica la imagen y la reduce: lado mayor de hasta 1024 px, con su transparencia. */
async function shrink(file: Blob): Promise<{ url: string; ratio: number }> {
  // De un GIF animado queda el primer cuadro.
  const bitmap = await createImageBitmap(file);
  try {
    const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext('2d');
    if (!context) throw new Error('sin lienzo');
    context.imageSmoothingQuality = 'high';
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    // WebP conserva la transparencia y pesa mucho menos que PNG; un motor que no lo
    // sepa escribir devuelve PNG, que también sirve.
    return { url: canvas.toDataURL('image/webp', 0.92), ratio: canvas.height / canvas.width };
  } finally {
    bitmap.close();
  }
}

const newId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

/**
 * Pega una imagen en esa cara, en `at` (fracciones de la tapa) o cerca del centro. Si no
 * se puede, falla con un `StickerError` que dice por qué.
 */
export async function addSticker(file: Blob, face: Face, at?: { x: number; y: number }): Promise<Sticker> {
  const full = () => stickersOn(snapshot(), face).length >= MAX_PER_FACE;
  const tooMany = () => t('Ya hay {max} imágenes en {face}: quitá alguna para pegar otra.', { max: MAX_PER_FACE, face: t(FACE_NAME[face]) });
  if (!file.type.startsWith('image/')) throw new StickerError(t('Eso no es una imagen. Se pueden pegar PNG, JPG, WebP y GIF.'));
  if (full()) throw new StickerError(tooMany());
  if (file.size > MAX_BYTES) throw new StickerError(t('Esa imagen pesa demasiado para pegarla en el cuaderno.'));
  let picture: { url: string; ratio: number };
  try {
    picture = await shrink(file);
  } catch {
    throw new StickerError(t('No se pudo abrir esa imagen. Se pueden pegar PNG, JPG, WebP y GIF.'));
  }
  if (full()) throw new StickerError(tooMany());
  const id = newId();
  try {
    await store('readwrite', (all) => all.put(picture.url, id));
  } catch {
    throw new StickerError(t('No se pudo guardar la imagen en esta PC.'));
  }
  images.set(id, picture.url);
  const current = snapshot();
  const onFace = stickersOn(current, face);
  // Que entre cómoda: a lo sumo algo menos de media tapa de ancho y de alto. Las que se
  // pegan sin elegir dónde caen apenas corridas, para que no queden una tapando a la otra.
  const step = (onFace.length % 5) * 0.035;
  const sticker: Sticker = fitPlacement({
    id,
    face,
    x: at?.x ?? 0.5 + step,
    y: at?.y ?? 0.62 + step,
    width: Math.min(0.44, 0.4 / (picture.ratio * COVER_RATIO)),
    ratio: picture.ratio,
    turn: 0,
    order: (onFace[onFace.length - 1]?.order ?? 0) + 1,
  });
  write([...current, sticker]);
  return sticker;
}

/** Mueve, agranda o gira una imagen. */
export function placeSticker(id: string, patch: Partial<Placement>) {
  const current = snapshot();
  if (!current.some((sticker) => sticker.id === id)) return;
  write(current.map((sticker) => (sticker.id === id ? fitPlacement({ ...sticker, ...patch }) : sticker)));
}

/** La trae encima de las demás de su cara. */
export function raiseSticker(id: string) {
  const current = snapshot();
  const sticker = current.find((item) => item.id === id);
  if (!sticker) return;
  const top = Math.max(...stickersOn(current, sticker.face).map((item) => item.order));
  if (sticker.order === top) return;
  write(current.map((item) => (item.id === id ? { ...item, order: top + 1 } : item)));
}

/** Quita una imagen; sus píxeles también se borran. */
export function removeSticker(id: string) {
  forget([id]);
  void store('readwrite', (all) => all.delete(id)).catch(() => {});
}

/** Quita todas las imágenes de las dos caras. */
export function clearStickers() {
  images.clear();
  write([]);
  void store('readwrite', (all) => all.clear()).catch(() => {});
}
