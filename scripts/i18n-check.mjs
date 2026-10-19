// Revisa las traducciones: qué frases usa el código con t(), tn(), mark() y plural() y no
// tienen inglés, qué frases del diccionario ya no se usan, y si el inglés conserva los
// {huecos} de la frase en español.
//
//   pnpm i18n                 resumen y lista de lo que falta (termina con código 1 si falta algo)
//   pnpm i18n --strict        además, las frases sobrantes del diccionario también hacen fallar
//   pnpm i18n --quiet         solo el resumen
//
// Mira el código, no la pantalla: solo ve frases escritas como texto entre comillas dentro de
// la llamada. Las que se arman con una variable (`t(opcion.etiqueta)`) tienen que estar
// marcadas con `mark('…')` donde se declaran. Lo que sí llegó a dibujarse sin traducción, con
// la interfaz en inglés, se ve en `window.__i18n.missing()`.
//
// Necesita Node 22.18 o más nuevo (lee el diccionario, que está en TypeScript, tal cual).

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'src');
const strict = process.argv.includes('--strict');
const quiet = process.argv.includes('--quiet');

// ---- el diccionario ----------------------------------------------------------------

let dictionary;
try {
  dictionary = await import(pathToFileURL(join(SRC, 'i18n/en/index.ts')).href);
} catch (reason) {
  console.error(`No se pudo leer el diccionario (src/i18n/en/index.ts): ${reason instanceof Error ? reason.message : reason}`);
  console.error('Hace falta Node 22.18 o más nuevo, o correr con: node --experimental-strip-types scripts/i18n-check.mjs');
  process.exit(2);
}
const { PARTS, EN } = dictionary;

// ---- el código ---------------------------------------------------------------------

function* files(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      // El diccionario y el motor de i18n no se revisan: nombran frases como ejemplo.
      if (path !== join(SRC, 'i18n')) yield* files(path);
    } else if (/\.(ts|tsx)$/.test(entry.name)) yield path;
  }
}

/** Fin de un texto entre comillas que empieza en `at` (`'`, `"` o una plantilla con sus ${…}). */
function endOfString(text, at) {
  const quote = text[at];
  let i = at + 1;
  while (i < text.length) {
    const c = text[i];
    if (c === '\\') i += 2;
    else if (c === quote) return i + 1;
    else if (quote !== '`' && c === '\n') return i; // sin cerrar: no arrastra el error a las líneas de abajo
    else if (quote === '`' && c === '$' && text[i + 1] === '{') i = endOfBraces(text, i + 1);
    else i++;
  }
  return i;
}

/** Fin de un bloque `{ … }` que abre en `at` (dentro de una plantilla). */
function endOfBraces(text, at) {
  let depth = 0;
  let i = at;
  while (i < text.length) {
    const c = text[i];
    if (c === "'" || c === '"' || c === '`') i = endOfString(text, i);
    else {
      if (c === '{') depth++;
      if (c === '}' && --depth === 0) return i + 1;
      i++;
    }
  }
  return i;
}

/** El mismo texto con los comentarios en blanco (mismas posiciones), para no leer los de ejemplo. */
function withoutComments(text) {
  const out = text.split('');
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') out[i++] = ' ';
    } else if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      const stop = end < 0 ? text.length : end + 2;
      for (; i < stop; i++) if (text[i] !== '\n') out[i] = ' ';
    } else if (c === "'" || c === '"' || c === '`') {
      i = endOfString(text, i);
    } else i++;
  }
  return out.join('');
}

/** Argumentos de la llamada cuyo paréntesis abre en `open`, cortados por las comas del primer nivel. */
function argumentsOf(text, open) {
  const found = [];
  let depth = 0;
  let from = open + 1;
  for (let i = open; i < text.length; ) {
    const c = text[i];
    if (c === "'" || c === '"' || c === '`') {
      i = endOfString(text, i);
      continue;
    }
    if (c === '(' || c === '[' || c === '{') depth++;
    if (c === ')' || c === ']' || c === '}') {
      depth--;
      if (depth === 0) {
        found.push({ text: text.slice(from, i), start: from });
        return found;
      }
    }
    if (c === ',' && depth === 1) {
      found.push({ text: text.slice(from, i), start: from });
      from = i + 1;
    }
    i++;
  }
  return found;
}

const LITERAL = /^(?:'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\$]|\\.|\$(?!\{))*`)$/s;

/** Qué argumentos de cada función son frases. */
const PHRASE_ARGS = { t: [0], mark: [0], tn: [1, 2], plural: [1, 2] };

const used = new Map(); // frase -> [{ file, line }]
const problems = [];
let dynamic = 0;

for (const file of files(SRC)) {
  const original = readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  const text = withoutComments(original);
  const lineAt = (index) => original.slice(0, index).split('\n').length;
  for (const match of text.matchAll(/(?<![\w$.])(t|tn|mark|plural)\(/g)) {
    const args = argumentsOf(text, match.index + match[0].length - 1);
    for (const position of PHRASE_ARGS[match[1]]) {
      const arg = args[position];
      if (!arg) continue;
      const literal = arg.text.trim();
      if (!LITERAL.test(literal)) {
        // `t(variable)` es válido (la frase se marcó donde se declara); una plantilla con ${…} no.
        if (/^`/.test(literal) && literal.includes('${')) problems.push({ file, line: lineAt(arg.start), what: 'la frase lleva ${…}: usá {huecos} y pasá los valores aparte' });
        else if (!/[A-Za-z_$]/.test(literal.replace(/'[^']*'/g, ''))) continue;
        else dynamic++;
        continue;
      }
      const phrase = new Function(`return ${literal}`)();
      if (phrase === '') continue;
      const where = { file, line: lineAt(arg.start) };
      if (!used.has(phrase)) used.set(phrase, []);
      used.get(phrase).push(where);
    }
  }
}

// ---- las cuentas -------------------------------------------------------------------

// Frases que usa el propio motor (src/i18n, que no se revisa): `quote()` pone las comillas de cada idioma.
for (const phrase of ['«{text}»']) if (!used.has(phrase)) used.set(phrase, [{ file: join(SRC, 'i18n/index.ts'), line: 0 }]);

const rel = (file) => relative(ROOT, file).replace(/\\/g, '/');
const holes = (text) => [...text.matchAll(/\{(\w+)\}/g)].map((hole) => hole[1]).sort().join(',');
const missing = [...used.keys()].filter((phrase) => !Object.hasOwn(EN, phrase));
const unused = Object.keys(EN).filter((phrase) => !used.has(phrase));

const owners = new Map();
const repeated = [];
for (const [part, entries] of Object.entries(PARTS)) {
  for (const [phrase, english] of Object.entries(entries)) {
    if (owners.has(phrase)) repeated.push({ phrase, a: owners.get(phrase), b: part, same: PARTS[owners.get(phrase)][phrase] === english });
    else owners.set(phrase, part);
  }
}

for (const [phrase, english] of Object.entries(EN)) {
  if (holes(phrase) !== holes(english)) problems.push({ what: `los {huecos} no coinciden: «${phrase}» → «${english}»` });
  if (phrase !== phrase.trim()) problems.push({ what: `la frase empieza o termina con espacio: «${phrase}»` });
  if (english.trim() === '') problems.push({ what: `la traducción está vacía: «${phrase}»` });
}
for (const { phrase, a, b, same } of repeated) {
  if (!same) problems.push({ what: `«${phrase}» está en ${a} y en ${b} con traducciones distintas` });
}

// ---- el informe --------------------------------------------------------------------

const byFile = new Map();
for (const phrase of missing) for (const where of used.get(phrase)) {
  if (!byFile.has(where.file)) byFile.set(where.file, []);
  byFile.get(where.file).push({ ...where, phrase });
}

if (!quiet) {
  for (const [file, rows] of byFile) {
    console.log(`\nSin inglés en ${rel(file)}:`);
    for (const { line, phrase } of rows.sort((a, b) => a.line - b.line)) console.log(`  ${line}: ${JSON.stringify(phrase)}`);
  }
  if (unused.length) {
    console.log(`\nEn el diccionario y sin usar (${unused.length}):`);
    for (const phrase of unused) console.log(`  ${JSON.stringify(phrase)}`);
  }
  const doubled = repeated.filter((row) => row.same);
  if (doubled.length) {
    console.log(`\nRepetidas con la misma traducción (${doubled.length}):`);
    for (const { phrase, a, b } of doubled) console.log(`  ${JSON.stringify(phrase)} en ${a} y en ${b}`);
  }
  if (problems.length) {
    console.log('\nProblemas:');
    for (const { file, line, what } of problems) console.log(`  ${file ? `${rel(file)}:${line} ` : ''}${what}`);
  }
}

console.log(`\nFrases usadas con t(): ${used.size}. Con inglés: ${used.size - missing.length}. Sin inglés: ${missing.length}.`);
console.log(
  `Diccionario: ${Object.keys(EN).length} frases (${Object.entries(PARTS)
    .map(([part, entries]) => `${part} ${Object.keys(entries).length}`)
    .join(', ')}). Sobrantes: ${unused.length}.${dynamic ? ` Llamadas con una variable en lugar de texto: ${dynamic}.` : ''}`,
);

process.exit(missing.length || problems.length || (strict && unused.length) ? 1 : 0);
