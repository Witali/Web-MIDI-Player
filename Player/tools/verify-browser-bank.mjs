import { fluidProfile, FLUID_PROFILE } from '../fluid-bank-mappings.js';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { FLUIDR3_SOURCE_SHA256 } from '../lazy-bank.js';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

export function verifyBrowserBank(directory = new URL('../soundfonts/fluidr3-gm/', import.meta.url)) {
  const root = directory instanceof URL ? directory : pathToFileURL(path.resolve(directory) + path.sep);
  try {
    const manifest = JSON.parse(fs.readFileSync(new URL('manifest.json', root)));
    if (manifest.schema !== 1 || manifest.source_sha256 !== FLUIDR3_SOURCE_SHA256 || fluidProfile(manifest) !== FLUID_PROFILE) throw Error('Unexpected source');
    const check = row => {
      if (!/^(bank\.sf3|LICENSE\.txt|samples\/[a-f0-9]{64}\.(ogg|pcm))$/.test(row.file)) throw Error('Invalid asset path');
      const file = new URL(row.file, root), bytes = fs.readFileSync(file);
      if (bytes.length !== row.bytes || hash(bytes) !== row.sha256) throw Error('Checksum mismatch: ' + fileURLToPath(file));
    };
    check(manifest.metadata);
    const checked = new Set();
    for (const row of manifest.samples) if (!checked.has(row.file)) { check(row); checked.add(row.file); }
    const license = fs.readFileSync(new URL('LICENSE.txt', root));
    if (hash(license) !== manifest.license_sha256) throw Error('License checksum mismatch');
    return manifest;
  } catch (error) {
    throw new Error('Restore browser SoundFont assets with git lfs pull or npm run setup. ' + error.message, { cause: error });
  }
}
