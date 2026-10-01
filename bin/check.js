#!/usr/bin/env bun
// Fails on anything internal in this public repo, on source maps, and on the ink filter applied to data.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const tracked = execFileSync('git', ['ls-files'], { encoding: 'utf8' }).split('\n').filter(Boolean);
const TEXT = /\.(js|css|html|md|toml|sql|py|json|yml|txt)$/;
const LEAKS = [
  [/\/home\/[a-z_][\w-]*/i, 'a home directory path'],
  [/\b(?:192\.168|10\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01]))\.\d{1,3}\.\d{1,3}\b/, 'a private network address'],
  [/\b(?:traptop|deskfart|lifeguard|ig-session|yt-session|gronka-promos)\b/i, 'an internal host, tool or private repo'],
  [/:8090\b/, 'an internal service port'],
  [/sourceMappingURL/, 'a source map reference'],
  [/thedorekaczynski/i, 'the personal account name'],
];
const DATA = /\b(?:bars?|charts?|graph|spark\w*|table|stats?|num\w*|uptime|up|state|svcs|meter)\b/i;

const problems = [];
for (const file of tracked) {
  if (file.endsWith('.map')) problems.push(`${file}: source maps must not be committed`);
  if (!TEXT.test(file) || file === 'bin/check.js') continue;
  const text = readFileSync(file, 'utf8');
  text.split('\n').forEach((line, i) => {
    for (const [re, what] of LEAKS) if (re.test(line)) problems.push(`${file}:${i + 1}: ${what}`);
  });
  if (file.endsWith('.css')) {
    for (const [, selector, body] of text.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      if (/filter:\s*url\(#ink/.test(body) && DATA.test(selector)) {
        problems.push(`${file}: ink filter on data (${selector.trim()}); it bends what it shows`);
      }
    }
  }
}
if (!/^upload_source_maps\s*=\s*false/m.test(readFileSync('wrangler.toml', 'utf8'))) {
  problems.push('wrangler.toml: set upload_source_maps = false');
}

if (problems.length) {
  console.error(`check failed:\n  ${problems.join('\n  ')}`);
  process.exit(1);
}
console.log('✓ nothing internal, no source maps, ink only on drawings');
