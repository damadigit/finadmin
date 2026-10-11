const Koa = require('koa');
const bodyParser = require('koa-bodyparser');
const request = require('supertest');
const db = require('./helpers/db');

// What a caller with an expired or invalid session is sent.
//
// The GraphQL client parses every response body as JSON. An unauthenticated
// request used to be answered with the bare text "Unauthorized", which made the
// client throw "Unexpected token 'U', "Unauthorized" is not valid JSON" - so a
// user whose session had ended was shown a parser error rather than being told
// to sign in again. The failure has to be legible for the client to act on it.
describe('auth failures answer with JSON', () => {
    let router, server;

    beforeAll(async () => {
        await db.connect();
        db.loadModels();

        const { auth: authMiddleware } = require('../server/auth');
        router = require('../server/api/rest/routes');

        const app = new Koa();
        app.use(bodyParser());
        app.use(authMiddleware());
        app.use(router.routes());
        server = app.listen(0);
    });

    afterAll(async () => {
        if (server) await new Promise(r => server.close(r));
        await db.disconnect();
    });

    const guarded = [
        ['get', '/api/user/me'],
        ['get', '/api/files-sign?path=photos/a.jpg'],
        ['post', '/api/fixHttps'],
        ['get', '/api/reports/visit/507f1f77bcf86cd799439011'],
        ['post', '/api/upload/photos'],
        ['post', '/api/migrate-files'],
    ];

    it.each(guarded)('%s %s answers 401 with a parseable body', async (method, url) => {
        const res = await request(server)[method](url);

        expect(res.status).toBe(401);
        expect(res.headers['content-type']).toMatch(/application\/json/);
        expect(() => JSON.parse(res.text)).not.toThrow();
        expect(res.body.errors[0].message).toBe('Unauthorized');
    });

    it('a token signed with the wrong secret is refused the same way', async () => {
        const jwt = require('jsonwebtoken');

        const res = await request(server)
            .get('/api/user/me')
            .set('Authorization', `Bearer ${jwt.sign({ id: 'someone' }, 'not-the-secret')}`);

        expect(res.status).toBe(401);
        expect(res.body.errors[0].message).toBe('Unauthorized');
    });

    it('a malformed token is refused the same way', async () => {
        const res = await request(server)
            .get('/api/user/me')
            .set('Authorization', 'Bearer not-a-token-at-all');

        expect(res.status).toBe(401);
        expect(res.body.errors[0].message).toBe('Unauthorized');
    });

    it('an empty bearer token is refused the same way', async () => {
        const res = await request(server)
            .get('/api/user/me')
            .set('Authorization', 'Bearer ');

        expect(res.status).toBe(401);
        expect(res.body.errors[0].message).toBe('Unauthorized');
    });

    it('accepts the token whichever way the scheme is cased', async () => {
        const jwt = require('jsonwebtoken');
        const { createUser } = require('./helpers/factories');
        const { auth } = require('../server/auth/config');

        const user = await createUser({ roles: ['handler'] });
        const token = jwt.sign({ id: user._id, roles: user.roles }, auth.secret);

        // The interface sends "bearer", the upload helper sends "Bearer".
        for (const scheme of ['Bearer', 'bearer', 'BEARER']) {
            const res = await request(server)
                .get('/api/user/me')
                .set('Authorization', `${scheme} ${token}`);

            expect(res.status).toBe(200);
            expect(res.body.email).toBe(user.email);
        }
    });
});