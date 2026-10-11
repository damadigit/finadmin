// End-to-end check against a real server process, over real HTTP.
//
// The unit tests call the router and the GraphQL schema directly. This starts the
// application the way production does and drives it the way a browser would,
// including the token flow, to confirm the wiring in index.js is right.
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const jwt = require('jsonwebtoken');

const ROOT = path.join(__dirname, '..');
const PORT = 41733;
const BASE = `http://127.0.0.1:${PORT}`;

const results = [];
const check = (name, pass, detail = '') => {
    results.push({ name, pass, detail });
    console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` :: ${detail}` : ''}`);
};

let mongod;

async function waitForServer(timeoutMs = 60000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        try {
            const res = await fetch(`${BASE}/api/auth/email`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email: 'nobody@example.com', password: 'x' }),
            });
            if (res.status < 500) return true;
        } catch (e) { /* not up yet */ }
        await new Promise(r => setTimeout(r, 500));
    }
    return false;
}

async function main() {
    process.env.JWT_SECRET = 'e2e-current-secret';
    process.env.JWT_LEGACY_SECRET = 'my-secret-code';
    process.env.JWT_EXPIRES_IN = '12h';
    process.env.PORT = String(PORT);
    process.env.MONGOLAB_URI = mongod.getUri('finadmin_e2e');
    delete process.env.NODE_ENV;

    const server = spawn(process.execPath, ['index.js'], {
        cwd: ROOT,
        env: { ...process.env },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    let serverErr = '';
    server.stderr.on('data', d => { serverErr += d.toString(); });

    if (!await waitForServer()) {
        check('server starts', false, serverErr.slice(0, 300));
        server.kill();
        return;
    }
    check('server starts with MONGOLAB_URI set', true);

    // --- register and log in -------------------------------------------------
    const reg = await fetch(`${BASE}/api/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'handler@example.com', password: 'correct horse' }),
    });
    const regBody = await reg.json();
    const handlerToken = regBody.token;
    check('registration returns a token', Boolean(handlerToken));

    // A token minted under the secret that used to be hardcoded in the source,
    // exactly as one issued before this change would look.
    const legacyToken = jwt.sign(
        { id: regBody.user.id || regBody.user._id, roles: ['handler'] },
        'my-secret-code'
    );

    const login = await fetch(`${BASE}/api/auth/email`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'handler@example.com', password: 'correct horse' }),
    });
    const loginBody = await login.json();
    check('login returns a token with an expiry', Boolean(jwt.decode(loginBody.token).exp),
        `exp=${jwt.decode(loginBody.token).exp}`);

    const gql = async (query, variables, token) => {
        const res = await fetch(`${BASE}/graphql`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...(token ? { authorization: `bearer ${token}` } : {}),
            },
            body: JSON.stringify({ query, variables }),
        });
        return res.json();
    };

    // --- the escalation that was possible before ----------------------------
    const escalate = await gql(
        'mutation($r: UpdateByIdUserInput!){ updateUser(record: $r){ record{ id roles } } }',
        { r: { _id: regBody.user.id || regBody.user._id, roles: ['financeAdmin'] } },
        handlerToken
    );
    check('a handler cannot promote their own role',
        Boolean(escalate.errors && escalate.errors[0].message.includes('Forbidden')),
        escalate.errors ? escalate.errors[0].message : 'mutation succeeded');

    const readUsers = await gql('{ allUsers { email } }', {}, handlerToken);
    check('a handler cannot list accounts',
        Boolean(readUsers.errors && readUsers.errors[0].message.includes('Forbidden')));

    const readPassword = await gql('{ allUsers { email password } }', {}, handlerToken);
    check('password is not readable',
        Boolean(readPassword.errors), readPassword.errors ? readPassword.errors[0].message : 'no error');

    const financeStillWorks = await gql('{ allAccountHolders { id } }', {}, handlerToken);
    check('the finance guard still refuses non-finance roles',
        Boolean(financeStillWorks.errors && financeStillWorks.errors[0].message.includes('Forbidden')));

    // --- records still readable by ordinary users ---------------------------
    const readRecords = await gql('{ allRecords { id name } }', {}, handlerToken);
    check('ordinary work is unaffected',
        !readRecords.errors && Array.isArray(readRecords.data.allRecords));

    // --- existing sessions keep working -------------------------------------
    const legacyCall = await gql('{ allRecords { id } }', {}, legacyToken);
    check('a token issued before the secret rotation still works',
        !legacyCall.errors, legacyCall.errors ? legacyCall.errors[0].message : '');

    // --- the file routes ----------------------------------------------------
    const noToken = await fetch(`${BASE}/api/files/photos/anything.jpg`);
    check('files are refused without a token', noToken.status === 401, `status=${noToken.status}`);

    const withToken = await fetch(`${BASE}/api/files/photos/anything.jpg`, {
        headers: { authorization: `Bearer ${handlerToken}` },
    });
    check('files are reachable with a token (404 for a missing file is correct)',
        withToken.status === 404, `status=${withToken.status}`);
    check('files no longer allow any origin',
        !withToken.headers.get('access-control-allow-origin'));

    const uploadNoToken = await fetch(`${BASE}/api/upload/photos`, { method: 'POST' });
    check('uploads are refused without a token', uploadNoToken.status === 401, `status=${uploadNoToken.status}`);

    const reportNoToken = await fetch(`${BASE}/api/reports/visit/507f1f77bcf86cd799439011`);
    check('visit reports are refused without a token', reportNoToken.status === 401, `status=${reportNoToken.status}`);

    const fixHttpsGet = await fetch(`${BASE}/api/fixHttps`);
    check('the database rewrite is not a GET', fixHttpsGet.status === 404 || fixHttpsGet.status === 401,
        `status=${fixHttpsGet.status}`);

    // --- the minted token actually authenticates over HTTP -----------------
    const uploadsDir = path.join(ROOT, 'uploads', 'photos');
    fs.mkdirSync(uploadsDir, { recursive: true });
    fs.writeFileSync(path.join(uploadsDir, 'e2e.jpg'), 'a beneficiary photograph');

    const realFile = await fetch(`${BASE}/api/files/photos/e2e.jpg`, {
        headers: { authorization: `Bearer ${handlerToken}` },
    });
    const body = await realFile.text();
    check('a stored file is served to a signed-in caller',
        realFile.status === 200 && body === 'a beneficiary photograph', `status=${realFile.status}`);

    fs.rmSync(path.join(uploadsDir, 'e2e.jpg'), { force: true });

    server.kill();
}

(async () => {
    const { MongoMemoryServer } = require('mongodb-memory-server');
    mongod = await MongoMemoryServer.create();

    try {
        await main();
    } catch (e) {
        check('unexpected error', false, e.message);
    }

    await mongod.stop();

    const failed = results.filter(r => !r.pass);
    console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
    process.exit(failed.length ? 1 : 0);
})();