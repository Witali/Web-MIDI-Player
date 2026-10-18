const ORIGIN = 'https://www.midiworld.com';
export function decodeEntities(text) {
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
    ndash: '–', mdash: '—', rsquo: '’', lsquo: '‘', eacute: 'é', euml: 'ë',
    auml: 'ä', ouml: 'ö', uuml: 'ü', szlig: 'ß', copy: '©' };
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (original, entity) => {
    if (entity[0] !== '#') return named[entity] ?? original;
    const point = entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
    return point > 0 && point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff)
      ? String.fromCodePoint(point) : '';
  });
}

export function plainText(html) {
  return decodeEntities(html.replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

export function siteUrl(input, base = ORIGIN) {
  try {
    const url = new URL(decodeEntities(input), base);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port ||
        !['midiworld.com', 'www.midiworld.com'].includes(url.hostname.toLowerCase())) return null;
    url.protocol = 'https:';
    url.hostname = 'www.midiworld.com';
    url.hash = '';
    return url;
  } catch { return null; }
}

