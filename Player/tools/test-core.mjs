import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url)), args = process.argv.slice(2);
const option = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
const build = path.join(root, '.cache', 'native-tests'); fs.mkdirSync(build, { recursive: true });
const binary = path.join(build, process.platform === 'win32' ? 'test_dsp.exe' : 'test_dsp');
let result;
if (process.platform === 'win32') {
  const visual = option('--vcvars', 'C:\\Program Files\\Microsoft Visual Studio\\18\\Community\\VC\\Auxiliary\\Build\\vcvars64.bat');
  if (!fs.existsSync(visual)) throw new Error('Pass --vcvars PATH to Visual C++ vcvars64.bat.');
  const quote = value => '"' + value + '"';
  const parameters = ['/nologo', '/O2', '/std:c11', '/fp:strict', '/W4', '/WX', '/D_CRT_SECURE_NO_WARNINGS',
    ...['dsp.c', 'envelopes.c', 'effects.c', 'test_dsp.c'].map(file => quote(path.join(root, 'native', file))), '/Fe:' + quote(binary)];
  const batch = path.join(build, 'compile.cmd');
  fs.writeFileSync(batch, `@echo off\r\ncall ${quote(visual)} >nul\r\nif errorlevel 1 exit /b 1\r\ncl ${parameters.join(' ')}\r\nexit /b %errorlevel%\r\n`);
  result = spawnSync('cmd.exe', ['/d', '/c', batch], { cwd: build, encoding: 'utf8' });
} else {
  result = spawnSync(option('--cc', 'cc'), ['-O3', '-std=c11', '-Wall', '-Wextra', '-Werror', '-ffp-contract=off',
    ...['dsp.c', 'envelopes.c', 'effects.c', 'test_dsp.c'].map(file => path.join(root, 'native', file)), '-lm', '-o', binary], { cwd: build, encoding: 'utf8' });
}
if (result.status !== 0) throw new Error(result.stdout + result.stderr || result.error?.message || 'Native C compilation failed');
const tested = spawnSync(binary, [], { encoding: 'utf8' });
if (tested.status !== 0) throw new Error(tested.stdout + tested.stderr);
console.log(tested.stdout.trim());
const golden = spawnSync(binary, ['--golden'], { encoding: 'utf8' });
if (golden.status !== 0) throw new Error(golden.stdout + golden.stderr);
const target = new URL('../tests/native-dsp-golden.json', import.meta.url);
fs.writeFileSync(target, JSON.stringify(JSON.parse(golden.stdout), null, 2) + '\n');
console.log('Native golden fixture saved for WASM/JavaScript parity tests.');
