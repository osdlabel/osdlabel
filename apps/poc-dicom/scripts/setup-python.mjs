/**
 * Creates apps/poc-dicom/.venv with the independent validators the bench
 * uses: highdicom + pydicom (structured reads of SR / SEG / ANN) and the
 * `dicom3tools` wheel (David Clunie's dciodvfy, the IOD checker). Optional:
 * the bench skips validation, and says so, when no Python is available.
 *
 *   node scripts/setup-python.mjs [--with-idc]   (--with-idc adds idc-index, for the manifest scripts)
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const venv = path.join(APP, '.venv');
const py =
  process.platform === 'win32'
    ? path.join(venv, 'Scripts', 'python.exe')
    : path.join(venv, 'bin', 'python');

if (!fs.existsSync(py)) execFileSync('python3', ['-m', 'venv', venv], { stdio: 'inherit' });
const pkgs = ['highdicom==0.28.2', 'pydicom==3.0.2', 'dicom3tools==20260927', 'numpy'];
if (process.argv.includes('--with-idc')) pkgs.push('idc-index');
execFileSync(py, ['-m', 'pip', 'install', '--quiet', ...pkgs], { stdio: 'inherit' });
console.log(`python ready: ${py}`);
