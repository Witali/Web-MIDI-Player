import fs from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
const override = process.argv.indexOf('--wabt');
const { default: factory } = await import(override >= 0 ? pathToFileURL(process.argv[override + 1]).href : 'wabt');
const wabt = await factory();
const source = new URL('../dsp/voice-mixer.wat', import.meta.url);
const scalar = await fs.readFile(source, 'utf8');
const simd = scalar.replace(/;; BEGIN_SCALAR_MIX[\s\S]*?;; END_SCALAR_MIX/, '')
  .replace(';; SIMD_MIX_CALL', '(call $mixSimd (local.get $n) (local.get $left) (local.get $right) (local.get $reverb) (local.get $chorus) (local.get $delay) (local.get $insert))')
  .replace(';; SIMD_MIX_FUNCTION', await fs.readFile(new URL('../dsp/mix-simd.wat', import.meta.url), 'utf8'));
for (const [name, text] of [['voice-mixer', scalar], ['voice-mixer-simd', simd]]) {
  const module = wabt.parseWat(`${name}.wat`, text, { simd: true });
  try {
    module.resolveNames(); module.validate();
    const { buffer } = module.toBinary({ canonicalize_lebs: true, write_debug_names: false });
    await fs.writeFile(new URL(`../dsp/${name}.wasm`, import.meta.url), buffer);
    console.log(`${name}: ${buffer.length} bytes`);
  } finally { module.destroy(); }
}
