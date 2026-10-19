// Compila Folio y deja el ejecutable en releases/Folio.exe.
//
//   pnpm release
//
// La versión se toma de package.json. Antes de publicar una nueva hay que subirla en
// package.json, src-tauri/Cargo.toml y src-tauri/tauri.conf.json, y anotarla en CHANGELOG.md.
import { execSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(root);

const version = JSON.parse(fs.readFileSync('package.json', 'utf8').replace(/^﻿/, '')).version;
const cargo = /^version = "(.+)"$/m.exec(fs.readFileSync('src-tauri/Cargo.toml', 'utf8'))?.[1];
const tauri = JSON.parse(fs.readFileSync('src-tauri/tauri.conf.json', 'utf8')).version;
if (cargo !== version || tauri !== version) {
  console.error(`Las versiones no coinciden: package.json ${version}, Cargo.toml ${cargo}, tauri.conf.json ${tauri}`);
  process.exit(1);
}
if (!fs.readFileSync('CHANGELOG.md', 'utf8').includes(`## ${version} `)) {
  console.error(`Falta anotar la versión ${version} en CHANGELOG.md`);
  process.exit(1);
}
if (!fs.readFileSync('src/mock.ts', 'utf8').includes(`version: '${version}'`)) {
  console.error(`src/mock.ts no tiene la versión ${version}`);
  process.exit(1);
}

const windows = process.platform === 'win32';
const binary = windows ? 'folio.exe' : 'folio';
const target = path.join('releases', windows ? 'Folio.exe' : 'Folio');
// Un ejecutable no se puede reemplazar mientras está abierto: ni el recién compilado ni
// el de esta misma versión, si se está usando.
if (windows) {
  for (const image of [binary, 'book.exe', path.basename(target)]) spawnSync('taskkill', ['/IM', image, '/F'], { stdio: 'ignore' });
}

execSync('pnpm tauri build --no-bundle', { stdio: 'inherit' });

fs.mkdirSync('releases', { recursive: true });
fs.copyFileSync(path.join('src-tauri', 'target', 'release', binary), target);
console.log(`\nListo: ${target} (${(fs.statSync(target).size / 1024 / 1024).toFixed(1)} MB)`);
