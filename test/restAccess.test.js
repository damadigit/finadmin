const Koa = require('koa');
const bodyParser = require('koa-bodyparser');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const path = require('path');
const fs = require('fs');
const db = require('./helpers/db');
const { mongoose } = require('./helpers/db');
const { createUser } = require('./helpers/factories');

// Loaded inside beforeAll, after the models are registered: both of these
// resolve the User model at require time.
let auth;
let authMiddleware;

const UPLOAD_ROOT = path.join(__dirname, '..', 'uploads');

// The routes that used to be reachable with no token at all. Each one either
// writes to the database, writes a file to the server, or reads back personal
// data about a named beneficiary.
describe('protected REST routes', () => {
    let router;
    let server;

    beforeAll(async () => {
        await db.connect();
        db.loadModels();

        ({ auth } = require('../server/auth/config'));
        ({ auth: authMiddleware } = require('../server/auth'));

        // Required after the models are registered: the route module resolves the
        // User model at load time.
        router = require('../server/api/rest/routes');
        const app = new Koa();
        app.use(bodyParser());
        // passport.initialize() has to be mounted, exactly as index.js does it.
        // Without it the JWT strategy has nowhere to attach the authenticated
        // user and every guarded route fails rather than hanging.
        app.use(authMiddleware());
        app.use(router.routes());
        server = app.listen(0);
    });

    afterAll(async () => {
        if (server) await new Promise(resolve => server.close(resolve));
        await db.disconnect();
    });

    beforeEach(async () => {
        await db.clearDatabase();
    });

    const tokenFor = user => jwt.sign({ id: user._id, roles: user.roles }, auth.secret);

    describe('without a token', () => {
        it('refuses an upload', async () => {
            const res = await request(server)
                .post('/api/upload/photos')
                .attach('file', Buffer.from('attacker content'), 'evil.txt');

            expect(res.status).toBe(401);
            expect(fs.existsSync(path.join(UPLOAD_ROOT, 'photos', 'evil.txt'))).toBe(false);
        });

        it('refuses reading a stored file', async () => {
            const dir = path.join(UPLOAD_ROOT, 'photos');
            fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(path.join(dir, 'private.jpg'), 'a beneficiary photograph');

            const res = await request(server).get('/api/files/photos/private.jpg');

            expect(res.status).toBe(401);
        });

        it('refuses generating a visit report', async () => {
            const res = await request(server).get('/api/reports/visit/507f1f77bcf86cd799439011');

            expect(res.status).toBe(401);
        });

        it('refuses the database rewrite, and it is not a GET any more', async () => {
            const Record = mongoose.model('Record');
            await Record.create({ name: 'Hana', place: { photo: 'http://x.com/a.jpg' } });

            const asGet = await request(server).get('/api/fixHttps');
            expect(asGet.status).not.toBe(200);

            const asPost = await request(server).post('/api/fixHttps');
            expect(asPost.status).toBe(401);

            // Nothing was rewritten by either attempt.
            const unchanged = await Record.findOne({ name: 'Hana' });
            expect(unchanged.place.photo).toBe('http://x.com/a.jpg');
        });
    });

    describe('with a token', () => {
        it('allows an upload into a known folder', async () => {
            const user = await createUser({ roles: ['handler'] });

            const res = await request(server)
                .post('/api/upload/photos')
                .set('Authorization', `Bearer ${tokenFor(user)}`)
                .attach('file', Buffer.from('a photograph'), 'holiday.jpg');

            expect(res.status).toBe(200);
            expect(res.body.filePath).toBe('/api/files/photos/holiday.jpg');

            fs.rmSync(path.join(UPLOAD_ROOT, 'photos', 'holiday.jpg'), { force: true });
        });

        it('serves a stored file to a signed-in user', async () => {
            const user = await createUser({ roles: ['handler'] });
            const dir = path.join(UPLOAD_ROOT, 'photos');
            fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(path.join(dir, 'readable.jpg'), 'a beneficiary photograph');

            const res = await request(server)
                .get('/api/files/photos/readable.jpg')
                .set('Authorization', `Bearer ${tokenFor(user)}`);

            expect(res.status).toBe(200);

            fs.rmSync(path.join(dir, 'readable.jpg'), { force: true });
        });

        it('does not hand the response to any other site', async () => {
            const user = await createUser({ roles: ['handler'] });
            const dir = path.join(UPLOAD_ROOT, 'photos');
            fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(path.join(dir, 'cors.jpg'), 'x');

            const res = await request(server)
                .get('/api/files/photos/cors.jpg')
                .set('Authorization', `Bearer ${tokenFor(user)}`);

            expect(res.headers['access-control-allow-origin']).toBeUndefined();

            fs.rmSync(path.join(dir, 'cors.jpg'), { force: true });
        });

        it('refuses an unknown folder rather than creating one', async () => {
            const user = await createUser({ roles: ['handler'] });

            const res = await request(server)
                .post('/api/upload/anything-the-caller-likes')
                .set('Authorization', `Bearer ${tokenFor(user)}`)
                .attach('file', Buffer.from('x'), 'note.txt');

            expect(res.status).toBeGreaterThanOrEqual(400);
            expect(fs.existsSync(path.join(UPLOAD_ROOT, 'anything-the-caller-likes'))).toBe(false);
        });

        it('keeps a traversing filename inside the upload folder', async () => {
            const user = await createUser({ roles: ['handler'] });

            const res = await request(server)
                .post('/api/upload/photos')
                .set('Authorization', `Bearer ${tokenFor(user)}`)
                .attach('file', Buffer.from('escaped'), '../../../../tmp/escaped.txt');

            // Rejected or renamed into place; either way nothing landed outside.
            expect(fs.existsSync('/tmp/escaped.txt')).toBe(false);

            if (res.status === 200) {
                const written = path.join(UPLOAD_ROOT, 'photos', path.basename(res.body.filePath));
                expect(fs.existsSync(written)).toBe(true);
                expect(path.basename(res.body.filePath)).not.toContain('..');
                fs.rmSync(written, { force: true });
            }
        });

        it('does not overwrite an existing file', async () => {
            const user = await createUser({ roles: ['handler'] });
            const dir = path.join(UPLOAD_ROOT, 'photos');
            fs.mkdirSync(dir, { recursive: true });
            const target = path.join(dir, 'letter.jpg');
            fs.writeFileSync(target, 'the original document');

            const res = await request(server)
                .post('/api/upload/photos')
                .set('Authorization', `Bearer ${tokenFor(user)}`)
                .attach('file', Buffer.from('a different document'), 'letter.jpg');

            expect(res.status).toBe(200);
            expect(fs.readFileSync(target, 'utf8')).toBe('the original document');
            expect(res.body.filePath).not.toBe('/api/files/photos/letter.jpg');

            fs.rmSync(target, { force: true });
            if (res.body.filePath) {
                fs.rmSync(path.join(dir, path.basename(res.body.filePath)), { force: true });
            }
        });
    });
});