const Koa = require('koa');
const bodyParser = require('koa-bodyparser');
const request = require('supertest');
const db = require('./helpers/db');
const { mongoose } = require('./helpers/db');

// The guard protecting beneficiary bank details is only as strong as this
// endpoint. If a caller can choose its own roles, they can register as a finance
// administrator and the guard means nothing.
describe('self registration', () => {
    let router;
    let server;

    beforeAll(async () => {
        await db.connect();
        db.loadModels();
        // Required after the models are registered: the route module resolves
        // the User model at load time.
        router = require('../server/api/rest/routes');
        const app = new Koa();
        app.use(bodyParser());
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

    const register = body => request(server).post('/api/auth/register').send(body);

    it('ignores roles supplied by the caller', async () => {
        await register({
            email: 'sneaky@example.com',
            password: 'hunter2',
            roles: ['financeAdmin'],
        });

        const user = await mongoose.model('User').findOne({ email: 'sneaky@example.com' });
        expect(Array.from(user.roles)).toEqual(['handler']);
    });

    it('ignores an admin role supplied by the caller', async () => {
        await register({ email: 'sneaky@example.com', password: 'hunter2', roles: ['admin'] });

        const user = await mongoose.model('User').findOne({ email: 'sneaky@example.com' });
        expect(Array.from(user.roles)).not.toContain('admin');
    });

    it('still registers a user when no roles are supplied', async () => {
        await register({ email: 'plain@example.com', password: 'hunter2' }).expect(200);

        const user = await mongoose.model('User').findOne({ email: 'plain@example.com' });
        expect(user).toBeTruthy();
        expect(Array.from(user.roles)).toEqual(['handler']);
    });

    it('still refuses a duplicate email', async () => {
        await register({ email: 'plain@example.com', password: 'hunter2' }).expect(200);
        await register({ email: 'plain@example.com', password: 'hunter2' }).expect(400);
    });
});