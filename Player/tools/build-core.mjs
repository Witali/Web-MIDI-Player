import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
const root = fileURLToPath(new URL('../', import.meta.url)), args = process.argv.slice(2);
const option = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
const sdk = option('--emsdk', process.env.EMSDK);
if (!sdk) throw new Error('Pass --emsdk PATH or set EMSDK to a local Emscripten SDK.');
const pythonDir = path.join(sdk, 'python');
const python = option('--python', process.platform === 'win32' ? path.join(pythonDir, fs.readdirSync(pythonDir).filter(n => fs.statSync(path.join(pythonDir, n)).isDirectory()).sort().at(-1), 'python.exe') : 'python3');
const command = path.join(sdk, 'upstream', 'emscripten', 'emcc.py');
const env = { ...process.env, EM_CONFIG: path.join(sdk, '.emscripten') };
function run(parameters) {
  const result = spawnSync(python, [command, ...parameters], { cwd: root, env, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || result.error?.message || 'C/WASM compilation failed');
  return result.stdout.trim();
}
const exports = ['dsp_abi_version', 'dsp_get_layout', 'dsp_begin_block', 'dsp_get_cache_stats', 'dsp_batch_abi_version', 'dsp_voice_command_size', 'dsp_process_batch', 'dsp_process_voice', 'dsp_process_voice_envelope', 'dsp_volume_envelope', 'dsp_modulation_envelope', 'dsp_chorus', 'dsp_delay_line', 'dsp_dattorro'];
const common = ['native/dsp.c', 'native/envelopes.c', 'native/effects.c', '-O3', '-std=c11', '-Wall', '-Wextra', '-Werror', '-ffp-contract=off', '-fno-fast-math',
  '--no-entry', '-sSTANDALONE_WASM=1', '-sALLOW_MEMORY_GROWTH=1', '-sINITIAL_MEMORY=1048576', '-sSTACK_SIZE=65536',
  '-sMAXIMUM_MEMORY=2147483648', '-Wl,--export=__heap_base', `-sEXPORTED_FUNCTIONS=${JSON.stringify(exports.map(name => '_' + name))}`];
for (const [name, flags] of [['voice-mixer', []], ['voice-mixer-simd', ['-msimd128']]]) {
  run([...common, ...flags, '-o', `dsp/${name}.wasm`]);
  console.log(`${name}: ${fs.statSync(path.join(root, 'dsp', name + '.wasm')).size} bytes`);
}
const hash = file => createHash('sha256').update(/\.[ch]$/.test(file)
  ? fs.readFileSync(path.join(root, file), 'utf8').replaceAll('\r\n', '\n') : fs.readFileSync(path.join(root, file))).digest('hex');
const files = ['native/dsp.c', 'native/dsp.h', 'native/envelopes.c', 'native/effects.c', 'dsp/voice-mixer.wasm', 'dsp/voice-mixer-simd.wasm'];
fs.writeFileSync(path.join(root, 'dsp', 'build.json'), JSON.stringify({ compiler: run(['--version']).split(/\r?\n/)[0],
  sources: files.filter(file => /\.[ch]$/.test(file)), sourceHashNormalization: 'LF',
  flags: common.filter(value => !value.endsWith('.c')), simdFlags: ['-msimd128'], arithmetic: 'Float64; explicit Float32 stores; no fast math or relaxed SIMD',
  sha256: Object.fromEntries(files.map(file => [file, hash(file)])) }, null, 2) + '\n');
