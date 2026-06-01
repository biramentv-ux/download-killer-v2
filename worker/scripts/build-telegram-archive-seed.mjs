import { readFileSync, writeFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';

function usage() {
  console.log('Usage: node scripts/build-telegram-archive-seed.mjs --out <output.sql> <messages.html> [more files...]');
}

function htmlDecode(input) {
  return input
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, '\'')
    .replace(/&apos;/g, '\'')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ');
}

function normalizeWhitespace(input) {
  return input.replace(/\s+/g, ' ').trim();
}

function sanitizeText(input) {
  return normalizeWhitespace(htmlDecode(input.replace(/<[^>]+>/g, ' ')));
}

function normalizeForSearch(input) {
  return input
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[^a-z0-9а-яё\s]+/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function urlTokenText(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    const tokens = [parsed.hostname, ...parsed.pathname.split('/').filter(Boolean)];
    return normalizeForSearch(tokens.join(' '));
  } catch {
    return '';
  }
}

function inferSourceFromUrl(rawUrl) {
  const lower = rawUrl.toLowerCase();
  if (lower.includes('spotify.com')) return 'spotify';
  if (lower.includes('youtube.com') || lower.includes('youtu.be')) return 'youtube';
  if (lower.includes('soundcloud.com')) return 'soundcloud';
  if (lower.includes('deezer.com')) return 'deezer';
  if (lower.includes('music.apple.com') || lower.includes('itunes.apple.com')) return 'apple';
  return 'unknown';
}

function normalizeArchiveUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return '';
  }
  const host = parsed.hostname.toLowerCase();
  const segments = parsed.pathname.split('/').filter(Boolean);

  if (host.includes('spotify.com')) {
    const type = segments[0];
    const id = segments[1];
    if (type && id) return `https://open.spotify.com/${type}/${id}`;
    return `https://open.spotify.com${parsed.pathname}`;
  }

  if (host.includes('deezer.com')) {
    const cleaned = segments.length >= 3 && /^[a-z]{2}$/i.test(segments[0] ?? '') ? segments.slice(1) : segments;
    if (cleaned[0] && cleaned[1]) return `https://www.deezer.com/${cleaned[0]}/${cleaned[1]}`;
    return `https://www.deezer.com${parsed.pathname}`;
  }

  if (host.includes('music.apple.com') || host.includes('itunes.apple.com')) {
    return `${parsed.origin}${parsed.pathname}`;
  }

  if (host.includes('youtube.com')) {
    const videoId = parsed.searchParams.get('v');
    if (videoId) return `${parsed.origin}${parsed.pathname}?v=${videoId}`;
    return `${parsed.origin}${parsed.pathname}`;
  }

  if (host === 'youtu.be') {
    const first = segments[0];
    return first ? `https://youtu.be/${first}` : 'https://youtu.be';
  }

  return `${parsed.origin}${parsed.pathname}`;
}

function splitArtistTitle(rawTitle) {
  const title = normalizeWhitespace(rawTitle);
  if (!title) return { artist: null, trackTitle: null };

  const separators = [' – ', ' - ', ' — '];
  for (const sep of separators) {
    if (title.includes(sep)) {
      const [artistPart, ...restParts] = title.split(sep);
      const artist = normalizeWhitespace(artistPart ?? '');
      const trackTitle = normalizeWhitespace(restParts.join(sep));
      return {
        artist: artist || null,
        trackTitle: trackTitle || null,
      };
    }
  }

  return { artist: null, trackTitle: title };
}

function parseMessageBlocks(html, exportFile) {
  const records = [];
  const chunks = html.split('<div class="message default clearfix');
  for (let i = 1; i < chunks.length; i += 1) {
    const chunk = `<div class="message default clearfix${chunks[i]}`;
    if (!chunk.includes('media_audio_file')) continue;

    const messageIdMatch = chunk.match(/id="message(\d+)"/i);
    const titleMatch = chunk.match(/<div class="title bold">\s*([\s\S]*?)\s*<\/div>/i);
    const botMatch = chunk.match(/<a href="https:\/\/t\.me\/([^"]+)">@/i);
    const infoMatch = chunk.match(/\|\s*<a href="(https?:\/\/[^"]+)">info<\/a>/i);
    if (!infoMatch?.[1]) continue;

    const sourceUrl = htmlDecode(infoMatch[1]);
    const normalizedUrl = normalizeArchiveUrl(sourceUrl);
    if (!normalizedUrl) continue;

    const source = inferSourceFromUrl(sourceUrl);
    const rawTitle = titleMatch ? sanitizeText(titleMatch[1]) : '';
    const { artist, trackTitle } = splitArtistTitle(rawTitle);
    const fallbackTitle = rawTitle || null;
    const title = trackTitle || fallbackTitle;
    const botUsername = botMatch?.[1] ?? null;
    const messageId = messageIdMatch?.[1] ?? null;
    const matchText = normalizeForSearch(`${artist ?? ''} ${title ?? ''} ${botUsername ?? ''}`) || urlTokenText(sourceUrl);

    records.push({
      normalized_url: normalizedUrl,
      source_url: sourceUrl,
      source,
      title,
      artist,
      bot_username: botUsername,
      match_text: matchText || normalizeForSearch(sourceUrl),
      export_file: exportFile,
      message_id: messageId,
    });
  }

  return records;
}

function parseRawLinks(html, exportFile) {
  const records = [];
  const linkRegex = /<a href="(https?:\/\/(?:open\.spotify\.com|www\.deezer\.com|music\.apple\.com|itunes\.apple\.com|soundcloud\.com|www\.youtube\.com|youtu\.be)[^"]+)">/gi;
  let match;
  while ((match = linkRegex.exec(html)) !== null) {
    const sourceUrl = htmlDecode(match[1]);
    const normalizedUrl = normalizeArchiveUrl(sourceUrl);
    if (!normalizedUrl) continue;
    const source = inferSourceFromUrl(sourceUrl);
    records.push({
      normalized_url: normalizedUrl,
      source_url: sourceUrl,
      source,
      title: null,
      artist: null,
      bot_username: null,
      match_text: urlTokenText(sourceUrl),
      export_file: exportFile,
      message_id: null,
    });
  }
  return records;
}

function escapeSql(value) {
  if (value === null || value === undefined) return 'NULL';
  return `'${String(value).replace(/'/g, "''")}'`;
}

function chooseBetterRecord(existing, candidate) {
  const existingScore = (existing.title ? 3 : 0) + (existing.artist ? 2 : 0) + (existing.bot_username ? 1 : 0);
  const candidateScore = (candidate.title ? 3 : 0) + (candidate.artist ? 2 : 0) + (candidate.bot_username ? 1 : 0);
  if (candidateScore > existingScore) {
    return candidate;
  }
  return existing;
}

function main() {
  const args = process.argv.slice(2);
  const outIndex = args.indexOf('--out');
  if (outIndex < 0 || !args[outIndex + 1]) {
    usage();
    process.exit(1);
  }

  const outputPath = resolve(args[outIndex + 1]);
  const inputFiles = args.filter((_, index) => index !== outIndex && index !== outIndex + 1);
  if (inputFiles.length === 0) {
    usage();
    process.exit(1);
  }

  const aggregate = new Map();
  let totalParsed = 0;
  for (const inputPath of inputFiles) {
    const absolutePath = resolve(inputPath);
    const html = readFileSync(absolutePath, 'utf8');
    const exportFile = basename(absolutePath);
    const rows = [
      ...parseMessageBlocks(html, exportFile),
      ...parseRawLinks(html, exportFile),
    ];
    totalParsed += rows.length;

    for (const row of rows) {
      const existing = aggregate.get(row.normalized_url);
      if (existing) {
        aggregate.set(row.normalized_url, chooseBetterRecord(existing, row));
      } else {
        aggregate.set(row.normalized_url, row);
      }
    }
  }

  const records = Array.from(aggregate.values()).sort((a, b) => a.normalized_url.localeCompare(b.normalized_url));
  const lines = [];
  lines.push('-- Generated by scripts/build-telegram-archive-seed.mjs');
  lines.push('DELETE FROM telegram_archive_tracks;');
  for (const row of records) {
    lines.push(
      `INSERT OR REPLACE INTO telegram_archive_tracks (` +
      'normalized_url, source_url, source, title, artist, bot_username, match_text, export_file, message_id' +
      `) VALUES (` +
      `${escapeSql(row.normalized_url)}, ` +
      `${escapeSql(row.source_url)}, ` +
      `${escapeSql(row.source)}, ` +
      `${escapeSql(row.title)}, ` +
      `${escapeSql(row.artist)}, ` +
      `${escapeSql(row.bot_username)}, ` +
      `${escapeSql(row.match_text)}, ` +
      `${escapeSql(row.export_file)}, ` +
      `${escapeSql(row.message_id)}` +
      ');',
    );
  }

  writeFileSync(outputPath, `${lines.join('\n')}\n`, 'utf8');
  console.log(`Parsed rows: ${totalParsed}`);
  console.log(`Unique records: ${records.length}`);
  console.log(`Output: ${outputPath}`);
}

main();
