const Koa = require('koa');
const bodyParser = require('koa-bodyparser');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const db = require('./helpers/db');
const { createUser } = require('./helpers/factories');

// What a freshly issued login token contains.
//
// The token is handed to the browser and anyone holding it can decode it. It was
// signed from the whole user document, so the bcrypt password hash rode along
// inside every login. Only the id and the roles belong in a token; the JWT
// strategy reads the rest back from the database per request.
describe('the login token', () => {
    let server;

    beforeAll(async () => {
        await db.connect();
        db.loadModels();

        const { auth: authMiddleware } = require('../server/auth');
        const router = require('../server/api/rest/routes');

        const app = new Koa();
        app.use(bodyParser());
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

    const login = (email, password) =>
        request(server).post('/api/auth/email').send({ email, password });

    it('carries no password hash', async () => {
        const password = 'kkooppssxx';
        const user = await createUser({ email: 'lidiyha@example.com', password });

        const res = await login(user.email, password);
        expect(res.status).toBe(200);

        const payload = jwt.decode(res.body.token);
        // The id is a bare identifier, not the document it used to be signed
        // from. Anything else would put the hash back in the token.
        expect(typeof payload.id).not.toBe('object');
        expect(JSON.stringify(payload)).not.toContain('$2a$');
        expect(JSON.stringify(payload)).not.toContain('password');
    });

    it('identifies the user by id and carries their roles', async () => {
        const user = await createUser({ roles: ['finance', 'financeAdmin'] });

        const res = await login(user.email, 'test-password');

        const payload = jwt.decode(res.body.token);
        expect(String(payload.id)).toBe(String(user._id));
        expect(payload.roles).toEqual(['finance', 'financeAdmin']);
    });

    it('still authenticates the requests it is presented on', async () => {
        const user = await createUser({ roles: ['handler'] });

        const res = await login(user.email, 'test-password');

        const me = await request(server)
            .get('/api/user/me')
            .set('Authorization', `Bearer ${res.body.token}`);

        expect(me.status).toBe(200);
        expect(me.body.email).toBe(user.email);
    });
});
