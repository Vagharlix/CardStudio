// Copies the frame scripts of mtgcardbuilder.com (groups, packs, version and
// mana symbol scripts) into web/js/frames, then downloads every image they
// refer to that the app does not have yet (PNG converted to WebP, like
// scripts/import-engine.mjs).
//
// Groups come from the #selectFrameGroup options of web/index.html; packs from
// the groups; other scripts from the loadScript() calls of the packs.
//
// Card fonts: web/css/card-fonts.css is rebuilt from the @font-face rules of
// the site's newest /css/style-<n>.css, and missing font files are downloaded.
//
// Run it after scripts/import-engine.mjs, which writes an older card-fonts.css.
//
// Usage: node scripts/import-site-frames.mjs [--scripts-only | --images-only | --fonts-only]
//        (needs Internet)
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import sharp from 'sharp';

const SITE = 'https://mtgcardbuilder.com';
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const web = path.join(root, 'web');
const framesDir = path.join(web, 'js/frames');
const only = ['scripts', 'images', 'fonts'].find((k) => process.argv.includes('--' + k + '-only'));
const SCRIPTS = !only || only === 'scripts';
const IMAGES = !only || only === 'images';
const FONTS = !only || only === 'fonts';
const KEEP_PNG = new Set(['/img/blank.png', '/img/black.png', '/img/blankThumb.png', '/img/blackThumb.png']);
const SAFE_SCRIPT = /^[A-Za-z0-9_.,()&+-]+\.js$/;
const SAFE_IMG = /^\/img\/[A-Za-z0-9_ .,()&+'!-]+(\/[A-Za-z0-9_ .,()&+'!-]+)*\.(png|svg|jpg|jpeg|webp|gif)$/i;

async function get(url, attempt = 1) {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (card-studio import)' } });
    if (res.status === 404 || res.status === 403) return null;
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return Buffer.from(await res.arrayBuffer());
  } catch (e) {
    if (attempt >= 4) throw new Error(url + ': ' + e.message);
    await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
    return get(url, attempt + 1);
  }
}
async function pool(items, size, fn) {
  const queue = items.slice();
  await Promise.all(Array.from({ length: size }, async () => {
    while (queue.length) await fn(queue.shift());
  }));
}

// ---------------------------------------------------------------- scripts
if (SCRIPTS) {
  const html = fs.readFileSync(path.join(web, 'index.html'), 'utf8');
  const select = html.slice(html.indexOf("id='selectFrameGroup'"), html.indexOf('</select>', html.indexOf("id='selectFrameGroup'")));
  const groups = [...select.matchAll(/<option value='([^']+)'/g)].map((m) => m[1]);
  const done = new Map(); // file name -> text
  const missing = [];
  let queue = groups.map((g) => 'group' + g + '.js');
  while (queue.length) {
    const batch = [...new Set(queue)].filter((f) => !done.has(f) && !missing.includes(f));
    queue = [];
    await pool(batch, 8, async (file) => {
      if (!SAFE_SCRIPT.test(file)) { missing.push(file + ' (unsafe name)'); return; }
      const body = await get(SITE + '/js/frames/' + encodeURIComponent(file));
      if (!body) { missing.push(file); return; }
      // Local copies are loaded without the site's cache-busting queries.
      const text = body.toString('utf8').replace(/(\/js\/frames\/[A-Za-z0-9_.,()&+-]+\.js)\?[^'"`\s)]*/g, '$1');
      done.set(file, text);
      if (/^group/.test(file)) {
        for (const v of text.matchAll(/value\s*:\s*(['"])([^'"]+)\1/g)) if (v[2] !== 'disabled') queue.push('pack' + v[2] + '.js');
      }
      for (const s of text.matchAll(/['"`]\/js\/frames\/([A-Za-z0-9_.,()&+-]+\.js)/g)) queue.push(s[1]);
    });
  }
  let added = 0, updated = 0, same = 0;
  for (const [file, text] of [...done.entries()].sort()) {
    const to = path.join(framesDir, file);
    const old = fs.existsSync(to) ? fs.readFileSync(to, 'utf8') : null;
    if (old === null) added++; else if (old.replace(/\r/g, '') === text.replace(/\r/g, '')) { same++; continue; } else updated++;
    fs.writeFileSync(to, text);
  }
  const unused = fs.readdirSync(framesDir).filter((f) => f.endsWith('.js') && !done.has(f));
  console.log(`scripts: ${done.size} on the site (added ${added}, updated ${updated}, same ${same})`);
  if (missing.length) console.log('  not on the site: ' + missing.join(', '));
  if (unused.length) console.log('  local scripts not referenced by the site: ' + unused.join(', '));
}

// ---------------------------------------------------------------- images
if (IMAGES) {
  const refs = new Set(), dynamic = new Set();
  for (const f of fs.readdirSync(framesDir).filter((n) => n.endsWith('.js'))) {
    const text = fs.readFileSync(path.join(framesDir, f), 'utf8');
    for (const m of text.matchAll(/(['"`])(\/?img\/[^'"`\n]*?)\1/g)) {
      const p = ('/' + m[2]).replace(/\/{2,}/g, '/');
      if (SAFE_IMG.test(p)) refs.add(p); else dynamic.add(f + ': ' + p);
    }
  }
  // Mana symbols: loadManaSymbols(['dir/name', ['dir/x.png', 'backSuffix', count], ...])
  // loads /img/manaSymbols/<path>(.svg unless .png), plus "back<i><suffix>" images.
  const mana = new Set();
  for (const f of fs.readdirSync(framesDir).filter((n) => n.endsWith('.js'))) {
    const text = fs.readFileSync(path.join(framesDir, f), 'utf8');
    let at = 0;
    while ((at = text.indexOf('loadManaSymbols(', at)) >= 0) {
      let i = at + 'loadManaSymbols('.length, depth = 1;
      for (; i < text.length && depth; i++) { if (text[i] === '(') depth++; else if (text[i] === ')') depth--; }
      let body = text.slice(at, i);
      at = i;
      const add = (p) => { const full = '/img/manaSymbols/' + p + (p.includes('.png') ? '' : '.svg'); if (SAFE_IMG.test(full)) mana.add(full); };
      body = body.replace(/\[\s*'([^']+)'\s*,\s*'([^']*)'\s*,\s*(\d+)\s*\]/g, (m, p, suffix, n) => {
        add(p);
        const name = p.split('.')[0].split('/').pop();
        for (let k = 0; k < Number(n); k++) add(p.replace(name, 'back' + k + suffix));
        return '';
      });
      for (const m of body.matchAll(/'([^']+)'/g)) add(m[1]);
    }
  }
  // Paths built at runtime (see the "paths built at runtime" list below):
  // versionStation.js picks /img/frames/station/{badges,pt}/<color>.png.
  for (const t of ['badges', 'pt']) for (const c of 'wubrgam') mana.add(`/img/frames/station/${t}/${c}.png`);
  // The engine shows "<image>Thumb.png" in the frame and mask pickers.
  const wanted = new Set([...refs, ...mana]);
  // (for .svg images too: src.replace('.svg', 'Thumb.png')).
  for (const p of refs) if (/\.(png|svg)$/i.test(p) && !/Thumb\.png$/i.test(p)) wanted.add(p.replace(/\.(png|svg)$/i, 'Thumb.png'));
  const local = (p) => path.join(web, /\.png$/i.test(p) && !KEEP_PNG.has(p) ? p.replace(/\.png$/i, '.webp') : p);
  const todo = [...wanted].filter((p) => !fs.existsSync(local(p))).sort();
  console.log(`images: ${refs.size} referenced + ${mana.size} mana symbols, ${todo.length} to fetch (thumbnails included)`);
  sharp.concurrency(1);
  let got = 0, bytes = 0;
  const notOnSite = [];
  await pool(todo, Math.max(4, os.cpus().length), async (p) => {
    const body = await get(SITE + encodeURI(p));
    if (!body) { notOnSite.push(p); return; }
    const to = local(p);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    if (to.endsWith('.webp') && /\.png$/i.test(p)) {
      try {
        await sharp(body, { limitInputPixels: false })
          .webp({ quality: /Thumb\.png$/i.test(p) ? 82 : 90, alphaQuality: 100, smartSubsample: true, effort: 4 })
          .toFile(to);
      } catch (e) {
        console.warn('convert failed, keeping original bytes:', p, e.message);
        fs.writeFileSync(to, body);
      }
    } else fs.writeFileSync(to, body);
    got++;
    bytes += fs.statSync(to).size;
  });
  const thumbsMissing = notOnSite.filter((p) => /Thumb\.png$/i.test(p));
  const fullMissing = notOnSite.filter((p) => !/Thumb\.png$/i.test(p));
  console.log(`  downloaded ${got} (${(bytes / 1048576).toFixed(1)} MB); not on the site: ${fullMissing.length} images, ${thumbsMissing.length} thumbnails`);
  if (fullMissing.length) console.log('  missing images:\n    ' + fullMissing.join('\n    '));
  if (dynamic.size) console.log('  paths built at runtime (check by hand):\n    ' + [...dynamic].join('\n    '));
  if (process.env.MISSING_LIST) fs.writeFileSync(process.env.MISSING_LIST, notOnSite.sort().join('\n') + '\n');
}

// ---------------------------------------------------------------- fonts
if (FONTS) {
  let css = null, cssName = '';
  for (let n = 9; n < 40; n++) {
    const body = await get(`${SITE}/css/style-${n}.css`);
    if (!body) break;
    css = body.toString('utf8');
    cssName = `style-${n}.css`;
  }
  if (!css) throw new Error('no /css/style-<n>.css on the site');
  const fontsDir = path.join(web, 'fonts');
  const localFonts = [];
  (function walk(dir) {
    for (const n of fs.readdirSync(dir)) {
      const full = path.join(dir, n);
      if (fs.statSync(full).isDirectory()) walk(full); else localFonts.push(full);
    }
  })(fontsDir);
  const SAFE_FONT = /^\/fonts\/[A-Za-z0-9_ .,()&+'-]+(\/[A-Za-z0-9_ .,()&+'-]+)*$/;
  const faces = css.replace(/\r/g, '').match(/@font-face\s*\{[^}]*\}/g) || [];
  const out = [], fetched = [], unavailable = [];
  for (let face of faces) {
    for (const m of [...face.matchAll(/url\(\s*(['"]?)([^)'"]+)\1\s*\)/g)]) {
      let url = m[2].split(/[?#]/)[0].replace(/^\.\.\//, '/');
      try { url = decodeURI(url); } catch { /* keep */ }
      if (!SAFE_FONT.test(url)) { unavailable.push(m[2] + ' (unsafe path)'); continue; }
      let file = path.join(web, url);
      if (!fs.existsSync(file)) {
        // upstream typo: missing extension
        const candidates = path.extname(url) ? [url] : [url, url + '.otf', url + '.ttf'];
        let body = null, used = url;
        for (const c of candidates) { body = await get(SITE + encodeURI(c)); if (body) { used = c; break; } }
        // the same file may already be in web/fonts under another folder
        const twin = body && localFonts.find((f) => path.basename(f).toLowerCase() === path.basename(used).toLowerCase() &&
          fs.statSync(f).size === body.length && fs.readFileSync(f).equals(body));
        if (twin) {
          url = '/' + path.relative(web, twin).split(path.sep).join('/');
        } else if (body) {
          file = path.join(web, used);
          fs.mkdirSync(path.dirname(file), { recursive: true });
          fs.writeFileSync(file, body);
          localFonts.push(file);
          fetched.push(used);
          url = used;
        } else {
          // not on the site under that name: same file elsewhere in web/fonts (name case may differ)
          const base = path.basename(url).toLowerCase();
          const same = localFonts.find((f) => path.basename(f).toLowerCase() === base);
          if (same) url = '/' + path.relative(web, same).split(path.sep).join('/');
          else { unavailable.push(url); continue; }
        }
      }
      face = face.replace(m[0], `url('${encodeURI(url)}')`);
    }
    out.push(face);
  }
  fs.writeFileSync(path.join(web, 'css/card-fonts.css'),
    `/* Card fonts used by the canvas renderer: the @font-face rules of mtgcardbuilder.com/css/${cssName}\n` +
    '   (generated by scripts/import-site-frames.mjs). */\n' + out.join('\n') + '\n');
  console.log(`fonts: ${faces.length} @font-face in ${cssName}, downloaded ${fetched.length}` +
    (unavailable.length ? `, not available: ${unavailable.join(', ')}` : ''));
  if (fetched.length) console.log('  ' + fetched.join('\n  '));
}
