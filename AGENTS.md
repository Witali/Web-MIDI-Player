# Preserve the reviewed MIDI library

- Keep the complete `public-library/` directory during repository cleanup and Git history rewriting. It is an intentional, tracked part of the website.
- Preserve its `midi/`, `sources/`, `manifest.json`, documentation, attribution, and rights evidence together.
- Do not classify this collection as private downloads, cache, or accidentally committed MIDI. Do not use repository-wide MIDI-extension removal filters that would remove it.
- If unrelated MIDI files need removal, target only their individually reviewed paths and preserve `public-library/` in the resulting history.
- `dist/public-library/` is generated output; the source collection to retain is `public-library/` at the repository root.
