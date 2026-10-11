const Koa = require('koa');
const bodyParser = require('koa-bodyparser');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const path = require('path');
const fs = require('fs');
const db = require('./helpers/db');
const { createUser } = require('./helpers/factories');

const UPLOAD_ROOT = path.join(__dirname, '..', 'uploads');

// A signed URL is what lets an <img> tag read a stored file without being able
// to send a token, and in doing so it restores the browser's HTTP cache. These
// cover both halves: that it works and is scoped, and that it expires.
describe('signed file urls', () => {
    let router, server, auth, authMiddleware;

    beforeAll(async () => {
        await db.connect();
        db.loadModels();
        ({ auth } = require('../server/auth/config'));
        ({ auth: authMiddleware } = require('../server/auth'));
        router = require('../server/api/rest/routes');

        const app = new Koa();
        app.use(bodyParser());
        app.use(authMiddleware());
        app.use(router.routes());
        server = app.listen(0);

    });

    const FIXTURE = () => {
        const dir = path.join(UPLOAD_ROOT, 'post_attachments');
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'signed.jpg'), 'a stored photograph');
    };

    afterAll(async () => {
        if (server) await new Promise(r => server.close(r));
        fs.rmSync(path.join(UPLOAD_ROOT, 'post_attachments', 'signed.jpg'), { force: true });
        await db.disconnect();
    });

    beforeEach(async () => {
        await db.clearDatabase();
        // Rewritten per test: one case deletes its fixture to prove the signature
        // does not carry across files, which must not affect the others.
        FIXTURE();
    });

    const tokenFor = user => jwt.sign({ id: user._id, roles: user.roles }, auth.secret);

    it('signs a path for a signed-in caller', async () => {
        const user = await createUser({ roles: ['handler'] });

        const res = await request(server)
            .get('/api/files-sign?path=post_attachments/signed.jpg')
            .set('Authorization', `Bearer ${tokenFor(user)}`);

        expect(res.status).toBe(200);
        expect(res.body.signature).toBeTruthy();
        expect(res.body.expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000));
    });

    it('refuses to sign for an anonymous caller', async () => {
        const res = await request(server).get('/api/files-sign?path=post_attachments/signed.jpg');
        expect(res.status).toBe(401);
    });

    it('refuses to sign a path outside the upload folders', async () => {
        const user = await createUser({ roles: ['handler'] });

        for (const path of ['../index.js', '/etc/passwd', 'photos/../../secrets.txt', '']) {
            const res = await request(server)
                .get(`/api/files-sign?path=${encodeURIComponent(path)}`)
                .set('Authorization', `Bearer ${tokenFor(user)}`);
            expect(res.status).toBe(400);
        }
    });

    it('serves the file to a valid signed url with no token at all', async () => {
        const user = await createUser({ roles: ['handler'] });
        const signed = await request(server)
            .get('/api/files-sign?path=post_attachments/signed.jpg')
            .set('Authorization', `Bearer ${tokenFor(user)}`);

        const res = await request(server).get(
            `/api/files/post_attachments/signed.jpg?exp=${signed.body.expiresAt}&sig=${signed.body.signature}`
        ).buffer();

        expect(res.status).toBe(200);
        expect(res.body.toString()).toBe('a stored photograph');
    });

    it('marks the response cacheable, but only for this caller', async () => {
        const user = await createUser({ roles: ['handler'] });
        const signed = await request(server)
            .get('/api/files-sign?path=post_attachments/signed.jpg')
            .set('Authorization', `Bearer ${tokenFor(user)}`);

        const res = await request(server).get(
            `/api/files/post_attachments/signed.jpg?exp=${signed.body.expiresAt}&sig=${signed.body.signature}`
        );

        // The browser may reuse this for the same user; a shared cache must not
        // store a beneficiary's document at all.
        expect(res.headers['cache-control']).toMatch(/private/);
        expect(res.headers['cache-control']).toMatch(/max-age=\d+/);
        expect(res.headers.vary).toContain('Authorization');
    });

    it('refuses a tampered signature', async () => {
        const user = await createUser({ roles: ['handler'] });
        const signed = await request(server)
            .get('/api/files-sign?path=post_attachments/signed.jpg')
            .set('Authorization', `Bearer ${tokenFor(user)}`);

        const res = await request(server).get(
            `/api/files/post_attachments/signed.jpg?exp=${signed.body.expiresAt}&sig=tampered`
        );

        expect(res.status).toBe(401);
    });

    it('refuses one file\'s signature on another file', async () => {
        const user = await createUser({ roles: ['handler'] });
        const signed = await request(server)
            .get('/api/files-sign?path=post_attachments/signed.jpg')
            .set('Authorization', `Bearer ${tokenFor(user)}`);

        // Same signature, different path: the signature covers the path, so this
        // must not open a different document.
        const other = path.join(UPLOAD_ROOT, 'post_attachments', 'other.jpg');
        fs.writeFileSync(other, 'a different document');

        const res = await request(server).get(
            `/api/files/post_attachments/other.jpg?exp=${signed.body.expiresAt}&sig=${signed.body.signature}`
        );

        expect(res.status).toBe(401);
        fs.rmSync(other, { force: true });
    });

    it('refuses an expired signature', async () => {
        const user = await createUser({ roles: ['handler'] });
        const signed = await request(server)
            .get('/api/files-sign?path=post_attachments/signed.jpg')
            .set('Authorization', `Bearer ${tokenFor(user)}`);

        const res = await request(server).get(
            `/api/files/post_attachments/signed.jpg?exp=${Math.floor(Date.now() / 1000) - 60}&sig=${signed.body.signature}`
        );

        expect(res.status).toBe(401);
    });

    it('refuses a request with neither a token nor a signature', async () => {
        const res = await request(server).get('/api/files/post_attachments/signed.jpg');
        expect(res.status).toBe(401);
    });

    it('still serves a file to a bearer-token caller without a signature', async () => {
        const user = await createUser({ roles: ['handler'] });

        const res = await request(server)
            .get('/api/files/post_attachments/signed.jpg')
            .set('Authorization', `Bearer ${tokenFor(user)}`);

        expect(res.status).toBe(200);
    });
});