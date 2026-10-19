// Medidas del cuaderno y de la ventana que lo contiene. La ventana no tiene borde para
// redimensionarla: su tamaño sale siempre de acá, a la medida del cuaderno elegido.
import type { CSSProperties } from 'react';
import type { BookSize, PresetSize, Spread, TextSize } from './types';

/**
 * Letra de las hojas, por tamaño: `font` es el cuerpo del texto y `line` el alto del
 * renglón, que es también la separación del rayado (el texto y las rayas comparten
 * medida). La mediana es la de siempre. Los renglones son pares y la letra ronda el 52 %
 * del renglón, así el texto se asienta con el mismo aire sobre la raya en los cuatro.
 */
export const TEXT_STYLES: Record<TextSize, { font: number; line: number }> = {
  small: { font: 13, line: 24 },
  medium: { font: 14.5, line: 28 },
  large: { font: 16.5, line: 32 },
  xlarge: { font: 19, line: 36 },
};
/** Del más chico al más grande: los atajos para agrandar y achicar la letra recorren este orden. */
export const TEXT_ORDER: TextSize[] = ['small', 'medium', 'large', 'xlarge'];

/**
 * Variables de CSS de la letra elegida (`--line` y `--text`). Las usan las hojas, la hoja
 * suelta y el diálogo de versiones; el cuaderno las pone sobre sí mismo en el mismo dibujo
 * que su geometría, para que el texto y los renglones nunca se midan con valores distintos.
 */
export function textVars(size: TextSize): CSSProperties {
  const { font, line } = TEXT_STYLES[size];
  return { '--line': `${line}px`, '--text': `${font}px` } as CSSProperties;
}

/**
 * Alto del cuaderno, en píxeles, para cada tamaño. "Pantalla completa" pide más de lo
 * que entra en cualquier monitor, así que termina ocupando todo el alto disponible.
 */
export const PRESET_HEIGHT: Record<PresetSize, number> = { pocket: 560, standard: 800, full: 4000 };
/** Proporción ancho/alto: una hoja (o la tapa) y dos hojas abiertas. */
const RATIO = { single: 0.76, double: 1.46 };
/** Mesa alrededor del cuaderno: lugar para las solapas arriba y para la sombra. */
export const DESK = { side: 24, top: 36, topWithoutTabs: 18, bottom: 32 };
export const MIN_HEIGHT = 480;

/** Borde o esquina del cuaderno de donde se lo estira: norte, sur, este, oeste y combinaciones. */
export type Grip = 'n' | 's' | 'e' | 'w' | 'nw' | 'ne' | 'sw' | 'se';

export interface Box {
  width: number;
  height: number;
}

/** Cómo está el cuaderno: de eso depende su proporción y cuánta mesa lo rodea. */
export interface Shape {
  spread: Spread;
  closed: boolean;
  tabs: boolean;
}

/** Cerrado ocupa una sola tapa aunque abierto sea de doble hoja. */
const ratioOf = (shape: Shape) => (shape.closed ? RATIO.single : RATIO[shape.spread]);

/** Tamaño de la ventana para un cuaderno dado. */
export function windowBox(book: Box, tabs: boolean): Box {
  return {
    width: book.width + DESK.side * 2,
    height: book.height + (tabs ? DESK.top : DESK.topWithoutTabs) + DESK.bottom,
  };
}

/** El alto más grande que puede tener el cuaderno sin que la ventana se salga de la pantalla. */
export function maxHeight(shape: Shape): number {
  const desk = windowBox({ width: 0, height: 0 }, shape.tabs);
  const room = { width: window.screen.availWidth - desk.width, height: window.screen.availHeight - desk.height };
  return Math.max(MIN_HEIGHT, Math.floor(Math.min(room.height, room.width / ratioOf(shape))));
}

/** Cuaderno de ese alto, llevado a lo que entra en la pantalla. */
export function boxForHeight(height: number, shape: Shape): Box {
  const fitted = Math.max(MIN_HEIGHT, Math.min(Math.floor(height), maxHeight(shape)));
  return { width: Math.round(fitted * ratioOf(shape)), height: fitted };
}

/** Cuánto cambia el alto del cuaderno cuando su ancho cambia en `dx` píxeles. */
export const heightForWidth = (dx: number, shape: Shape) => dx / ratioOf(shape);

/** Tamaño del cuaderno para el tamaño elegido; `custom` es el alto del tamaño a medida. */
export function bookBox(size: BookSize, custom: number, shape: Shape): Box {
  return boxForHeight(size === 'custom' ? custom : PRESET_HEIGHT[size], shape);
}

/** Si ese alto coincide con un tamaño estándar, cuál; si no, es un tamaño a medida. */
export function sizeForHeight(height: number, shape: Shape): BookSize {
  const max = maxHeight(shape);
  if (height >= max) return 'full';
  if (height === PRESET_HEIGHT.standard) return 'standard';
  if (height === PRESET_HEIGHT.pocket) return 'pocket';
  return 'custom';
}

/**
 * Al estirar a mano, el cuaderno se "pega" a los tamaños estándar cuando pasa muy cerca:
 * lo justo para poder caer en ellos, sin que se note como un salto.
 */
export function snapHeight(height: number, shape: Shape, reach = 5): number {
  const max = maxHeight(shape);
  const stops = [PRESET_HEIGHT.pocket, PRESET_HEIGHT.standard, max].filter((stop) => stop <= max);
  const near = stops.find((stop) => Math.abs(stop - height) <= reach);
  return near ?? Math.max(MIN_HEIGHT, Math.min(Math.round(height), max));
}
