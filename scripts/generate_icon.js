/**
 * Generate the extension icon (images/icon.png).
 *
 * Layout:
 *   - black circular tile (full canvas),
 *   - JetBrains suspendCall dark glyph centred at ~58% of the canvas.
 *
 * Usage:
 *   node scripts/generate_icon.js
 *
 * Also re-downloads the suspension gutter SVGs used by the editor decorations
 * into `images/`.
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

const ROOT = path.resolve(__dirname, '..');
const IMAGES_DIR = path.join(ROOT, 'images');
const CACHE_DIR = path.resolve(__dirname, '.cache');
const OUT_FILE = path.join(IMAGES_DIR, 'icon.png');
const SIZE = 256;
const GLYPH_RATIO = 0.58;

const BASE_URL =
    'https://intellij-icons.jetbrains.design/icons/KotlinBaseResourcesIcons/org/jetbrains/kotlin/idea/icons/expui/';

/** Icon glyph used for the extension logo. */
const LOGO_ICON = 'suspendCall@14x14_dark.svg';

/** Gutter decoration SVGs placed directly into images/. */
const GUTTER_SVGS = [
    // suspendCall is only available in the @14x14 ExpUI size variant
    { name: 'suspendCall.svg',             url: `${BASE_URL}suspendCall%4014x14.svg` },
    { name: 'suspendCall_dark.svg',        url: `${BASE_URL}suspendCall%4014x14_dark.svg` },
    // the remaining icons use the standard (no-size-suffix) ExpUI path
    { name: 'suspendDeclaration.svg',      url: `${BASE_URL}suspendDeclaration.svg` },
    { name: 'suspendDeclaration_dark.svg', url: `${BASE_URL}suspendDeclaration_dark.svg` },
    { name: 'suspendFunction.svg',         url: `${BASE_URL}suspendFunction.svg` },
    { name: 'suspendFunction_dark.svg',    url: `${BASE_URL}suspendFunction_dark.svg` },
    { name: 'suspendMethod.svg',           url: `${BASE_URL}suspendMethod.svg` },
    { name: 'suspendMethod_dark.svg',      url: `${BASE_URL}suspendMethod_dark.svg` },
];

async function main() {
    let sharp;
    try {
        sharp = require('sharp');
    } catch {
        console.error(
            "Missing dependency 'sharp'. Install it first:\n" +
            '  bun install\n'
        );
        process.exit(1);
    }

    fs.mkdirSync(IMAGES_DIR, { recursive: true });
    fs.mkdirSync(CACHE_DIR, { recursive: true });

    // Download gutter SVGs into images/ (always refresh)
    for (const { name, url } of GUTTER_SVGS) {
        const dest = path.join(IMAGES_DIR, name);
        console.log(`→ Downloading ${name}…`);
        await download(url, dest);
    }

    // Download the logo glyph into cache
    const logoCachePath = path.join(CACHE_DIR, LOGO_ICON);
    if (!fs.existsSync(logoCachePath)) {
        console.log(`→ Downloading logo glyph ${LOGO_ICON}…`);
        await download(`${BASE_URL}suspendCall%4014x14_dark.svg`, logoCachePath);
    }

    // Build icon.png: black circle + centred glyph
    const tileSvg = `
<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">
  <circle cx="${SIZE / 2}" cy="${SIZE / 2}" r="${SIZE / 2}" fill="#1B1B1F"/>
</svg>`;
    const tile = await sharp(Buffer.from(tileSvg)).png().toBuffer();

    const glyphSize = Math.round(SIZE * GLYPH_RATIO);
    const glyphTrimmed = await sharp(logoCachePath, { density: 1024 })
        .trim()
        .png()
        .toBuffer();
    const glyph = await sharp(glyphTrimmed)
        .resize(glyphSize, glyphSize, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
        .png()
        .toBuffer();
    const glyphLeft = Math.round((SIZE - glyphSize) / 2);
    const glyphTop = Math.round((SIZE - glyphSize) / 2);

    await sharp(tile)
        .composite([{ input: glyph, left: glyphLeft, top: glyphTop }])
        .png({ compressionLevel: 9 })
        .toFile(OUT_FILE);

    console.log(`✓ Wrote ${path.relative(process.cwd(), OUT_FILE)} (${SIZE}x${SIZE})`);
}

function download(url, destPath, redirects = 5) {
    return new Promise((resolve, reject) => {
        https
            .get(
                url,
                {
                    headers: {
                        'User-Agent': 'vscode-kotlinx-coroutine/icon-generator',
                        Accept: '*/*',
                    },
                },
                res => {
                    if (
                        res.statusCode &&
                        res.statusCode >= 300 &&
                        res.statusCode < 400 &&
                        res.headers.location
                    ) {
                        if (redirects <= 0) {
                            return reject(new Error(`Too many redirects for ${url}`));
                        }
                        const next = new URL(res.headers.location, url).toString();
                        res.resume();
                        return resolve(download(next, destPath, redirects - 1));
                    }
                    if (res.statusCode !== 200) {
                        return reject(new Error(`GET ${url} failed: HTTP ${res.statusCode}`));
                    }
                    const file = fs.createWriteStream(destPath);
                    res.pipe(file);
                    file.on('finish', () => file.close(() => resolve(undefined)));
                    file.on('error', reject);
                }
            )
            .on('error', reject);
    });
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
