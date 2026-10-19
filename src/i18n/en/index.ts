import { classifier } from './classifier.ts';
import { common } from './common.ts';
import { finder } from './finder.ts';
import { notebook } from './notebook.ts';
import { settings } from './settings.ts';
import { tutorial } from './tutorial.ts';

/**
 * Diccionario español → inglés, partido por área: quien traduce una pantalla agrega su
 * archivo acá y no pisa a quien traduce otra. La clave es la frase en español, tal cual está
 * en el código; el valor, su inglés, con los mismos {huecos}. Una frase puede estar en un
 * solo archivo (`pnpm i18n` avisa si se repite con otra traducción).
 */
export const PARTS: Record<string, Record<string, string>> = { common, finder, settings, classifier, tutorial, notebook };

export const EN: Record<string, string> = Object.assign({}, ...Object.values(PARTS));
