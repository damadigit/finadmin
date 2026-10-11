// Drives the signed-URL flow the way the browser now does: plain GETs with no
// Authorization header, then checks the response can be cached and reused.
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const jwt = require('jsonwebtoken');
const { MongoMemoryServer } = require('mongodb-memory-server');

const ROOT = path.join(__dirname, '..');
const PORT = 41755;
const BASE = `http://127.0.0.1:${PORT}`;

const results = [];
const check = (name, pass, detail = '') => {
    results.push(pass);
    console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` :: ${detail}` : ''}`);
};

(async () => {
    process.env.JWT_SECRET = 'e2e-signing-secret';
    delete process.env.JWT_LEGACY_SECRET;
    process.env.PORT = String(PORT);
    process.env.NODE_ENV = 'development';

    const mongod = await MongoMemoryServer.create();
    process.env.MONGOLAB_URI = mongod.getUri('finadmin_signing');

    // A real file on disk, as a post attachment would be.
    const dir = path.join(ROOT, 'uploads', 'post_attachments');
    fs.mkdirSync(dir, { recursive: true });
    const fixture = path.join(dir, 'e2e-cache.jpg');
    // Valid JPEG magic bytes so the response is typed as an image.
    fs.writeFileSync(fixture, Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(2048)]));

    const server = spawn(process.execPath, ['index.js'], { cwd: ROOT, env: { ...process.env }, stdio: 'ignore' });

    const up = async () => {
        const deadline = Date.now() + 60000;
        while (Date.now() < deadline) {
            try {
                const r = await fetch(`${BASE}/api/auth/email`, {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ email: 'x@y.com', password: 'x' }),
                });
                if (r.status < 500) return true;
            } catch (e) { /* not up */ }
            await new Promise(r => setTimeout(r, 500));
        }
        return false;
    };

    if (!await up()) {
        check('server starts', false);
    } else {
        check('server starts', true);

        // Register a user so we can sign a URL the way the browser app does.
        const reg = await (await fetch(`${BASE}/api/auth/register`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email: 'cache@example.com', password: 'pw' }),
        })).json();
        const token = reg.token;

        // Step 1: exchange the token for a signed URL, exactly as the client does.
        const signRes = await fetch(`${BASE}/api/files-sign?path=post_attachments/e2e-cache.jpg`, {
            headers: { Authorization: `Bearer ${token}` },
        });
        const signed = await signRes.json();
        check('signs a path for a signed-in caller', signRes.status === 200 && !!signed.signature);

        const url = `${BASE}/api/files/post_attachments/e2e-cache.jpg?exp=${signed.expiresAt}&sig=${encodeURIComponent(signed.signature)}`;

        // Step 2: request it with NO auth header at all, like an <img> tag.
        const res = await fetch(url);
        check('serves the file to a plain GET with no token', res.status === 200, `status=${res.status}`);
        check('body is the image bytes', (await res.arrayBuffer()).byteLength === 2052);

        // Step 3: the headers that make the browser reuse it.
        const cc = res.headers.get('cache-control') || '';
        check('response is cacheable', /max-age=\d+/.test(cc), `Cache-Control: ${cc}`);
        check('cache is private, not shared', /private/.test(cc), `Cache-Control: ${cc}`);
        check('varies on the authorization header',
            (res.headers.get('vary') || '').toLowerCase().includes('authorization'),
            `Vary: ${res.headers.get('vary')}`);

        // Step 4: the signed URL is reusable - this is the whole point.
        const again = await fetch(url);
        check('the same signed url works again', again.status === 200);

        // Step 5: and it does not outlive its expiry.
        const expired = `${BASE}/api/files/post_attachments/e2e-cache.jpg?exp=${Math.floor(Date.now() / 1000) - 5}&sig=${encodeURIComponent(signed.signature)}`;
        check('an expired signature is refused', (await fetch(expired)).status === 401);

        // Step 6: no credential at all is still refused.
        check('an unsigned, untokened request is refused',
            (await fetch(`${BASE}/api/files/post_attachments/e2e-cache.jpg`)).status === 401);

        // Step 7: one file's signature cannot open another.
        fs.writeFileSync(path.join(dir, 'e2e-other.jpg'), Buffer.alloc(16));
        const otherRes = await fetch(`${BASE}/api/files/post_attachments/e2e-other.jpg?exp=${signed.expiresAt}&sig=${encodeURIComponent(signed.signature)}`);
        check("one file's signature does not open another", otherRes.status === 401, `status=${otherRes.status}`);
        fs.rmSync(path.join(dir, 'e2e-other.jpg'), { force: true });

        fs.rmSync(fixture, { force: true });
    }

    server.kill();
    await mongod.stop();

    const failed = results.filter(r => !r).length;
    console.log(`\n${results.length - failed}/${results.length} checks passed`);
    process.exit(failed ? 1 : 0);
})();