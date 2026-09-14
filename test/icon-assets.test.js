const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));

function readPngDimensions(file) {
    const data = fs.readFileSync(file);
    assert.ok(data.length > 24, `${file} is empty or truncated`);
    assert.deepEqual([...data.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
    assert.equal(data.subarray(12, 16).toString('ascii'), 'IHDR');
    return { width: data.readUInt32BE(16), height: data.readUInt32BE(20), colorType: data[25] };
}

test('extension icon PNGs decode structurally at exact Chrome sizes with alpha', () => {
    for (const size of [16, 32, 48, 128]) {
        const dimensions = readPngDimensions(path.join(root, `icons/icon${size}.png`));
        assert.deepEqual({ width: dimensions.width, height: dimensions.height }, { width: size, height: size });
        assert.ok([4, 6].includes(dimensions.colorType), `icon${size}.png must include an alpha channel`);
    }
});

test('master SVG is self-contained vector artwork without script, raster, font, or remote dependency', () => {
    const svg = fs.readFileSync(path.join(root, 'icons/liveflow.svg'), 'utf8');
    assert.match(svg, /^<\?xml[\s\S]*<svg\b/);
    assert.match(svg, /viewBox="0 0 128 128"/);
    assert.match(svg, /#0B1220|#0b1220/);
    for (const color of ['#00E5FF', '#FF3D9E', '#FFD600', '#FFFFFF']) assert.match(svg, new RegExp(color, 'i'));
    assert.doesNotMatch(svg, /<script\b|<image\b|<text\b|@font-face|filter\s*=|href\s*=\s*["'](?!#)/i);
});

test('manifest assigns the formal icon set without changing extension capabilities', () => {
    assert.deepEqual(manifest.icons, {
        16: 'icons/icon16.png', 32: 'icons/icon32.png', 48: 'icons/icon48.png', 128: 'icons/icon128.png'
    });
    assert.deepEqual(manifest.action.default_icon, { 16: 'icons/icon16.png', 32: 'icons/icon32.png' });
    assert.deepEqual(manifest.permissions, ['storage']);
    assert.equal(Object.hasOwn(manifest, 'host_permissions'), false);
    assert.equal(Object.hasOwn(manifest, 'background'), false);
});
