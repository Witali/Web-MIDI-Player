"""Reproduce the CC0 MIDI from the retained Noctave MusicXML score.

Requires music21==9.9.1 and defusedxml==0.7.1; not needed to build the website.
The generated MIDI is dedicated to CC0 1.0, like its source score.
"""
from pathlib import Path
import hashlib
import json

import defusedxml
defusedxml.defuse_stdlib()
import music21
from music21 import converter

if music21.__version__ != '9.9.1':
    raise RuntimeError('Use music21==9.9.1 for reproducible MIDI output')

root = Path(__file__).resolve().parents[1]
manifest = json.loads((root / 'manifest.json').read_text(encoding='utf-8'))
track = next(track for track in manifest['tracks'] if track['key'] == 'rimsky-korsakov-flight-of-the-bumblebee')
source = root / track['rights']['sourceFile']
if hashlib.sha256(source.read_bytes()).hexdigest() != track['rights']['sourceSha256']:
    raise RuntimeError('The reviewed MusicXML source has changed')

score = converter.parse(source, forceSource=True)
# SMF has no score repeat marks: put the repeated measures on the timeline.
expanded = score.expandRepeats()
output = root / track['file']
expanded.write('midi', fp=output)
print(output)
print('SHA-256:', hashlib.sha256(output.read_bytes()).hexdigest())
