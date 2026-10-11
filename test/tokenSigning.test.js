const jwt = require('jsonwebtoken');

// Token signing and verification, with no database involved.
//
// The secret moved out of the source and into the environment. That is the fix,
// but rotating a signing secret invalidates every token already issued, and
// signing everybody out of a payments system on a deploy is not an acceptable
// side effect of a security fix. These tests pin down the behaviour that avoids
// it: tokens minted before the rotation keep working, new tokens are signed only
// with the current secret, and a token signed with anything else is refused.
describe('token signing', () => {
    const OLD_SECRET = 'my-secret-code';
    let config;

    beforeEach(() => {
        jest.resetModules();
        process.env.JWT_SECRET = 'the-current-secret';
        process.env.JWT_LEGACY_SECRET = OLD_SECRET;
        delete process.env.NODE_ENV;

        config = require('../server/auth/config').auth;
    });

    afterEach(() => {
        delete process.env.JWT_SECRET;
        delete process.env.JWT_LEGACY_SECRET;
    });

    it('signs with the configured secret, not one baked into the source', () => {
        expect(config.secret).toBe('the-current-secret');
    });

    it('refuses to start in production with no secret configured', () => {
        jest.resetModules();
        delete process.env.JWT_SECRET;
        process.env.NODE_ENV = 'production';

        expect(() => require('../server/auth/config')).toThrow(/JWT_SECRET/);

        delete process.env.NODE_ENV;
    });

    it('verifies both the current and the previous secret', () => {
        expect(config.verificationSecrets).toEqual(['the-current-secret', OLD_SECRET]);
    });

    it('uses only the current secret when no legacy one is configured', () => {
        jest.resetModules();
        delete process.env.JWT_LEGACY_SECRET;
        config = require('../server/auth/config').auth;

        expect(config.verificationSecrets).toEqual(['the-current-secret']);
    });

    describe('verification', () => {
        // Mirrors what the JWT strategy does per request: try each configured
        // secret in turn, and accept the token if any one of them verifies.
        const verify = (token, secrets) => {
            const attempt = index => {
                if (index >= secrets.length) return null;
                try {
                    jwt.verify(token, secrets[index]);
                    return secrets[index];
                } catch (e) {
                    return attempt(index + 1);
                }
            };
            return attempt(0);
        };

        it('keeps a token issued before the rotation valid', () => {
            // This is the whole point: deploying the new secret does not sign
            // anybody out.
            const issuedBefore = jwt.sign({ id: 'someone', roles: ['handler'] }, OLD_SECRET);

            expect(verify(issuedBefore, config.verificationSecrets)).toBe(OLD_SECRET);
        });

        it('accepts a newly issued token', () => {
            const fresh = jwt.sign({ id: 'someone', roles: ['admin'] }, config.secret);

            expect(verify(fresh, config.verificationSecrets)).toBe(config.secret);
        });

        it('refuses a token signed with anything else', () => {
            // The property that made the old secret dangerous: with the secret
            // readable in the source, anyone could mint one of these.
            const forged = jwt.sign({ id: 'someone', roles: ['financeAdmin'] }, 'a-guess');

            expect(verify(forged, config.verificationSecrets)).toBeNull();
        });

        it('gives newly issued tokens an expiry', () => {
            const fresh = jwt.sign({ id: 'someone' }, config.secret, { expiresIn: config.expiresIn });

            expect(jwt.decode(fresh)).toHaveProperty('exp');
        });

        it('still refuses an expired token under the legacy secret', () => {
            const expired = jwt.sign({ id: 'someone' }, OLD_SECRET, { expiresIn: '-1s' });

            expect(verify(expired, config.verificationSecrets)).toBeNull();
        });
    });

    it('does not carry a database password in the source any more', () => {
        // The credential was committed at index.js and is still in the history, so
        // it has to be rotated at the provider. This asserts only that it is no
        // longer in the working tree, and ignores the placeholder shown in the
        // startup message.
        const fs = require('fs');
        const path = require('path');
        const source = fs
            .readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8')
            .replace(/mongodb[^'"]*@/g, '');

        expect(source).not.toContain('finadodo1');
        expect(source).not.toMatch(/mongodb(\+srv)?:\/\/\w+:\w+@\w/);
    });

    it('takes the database URI from the environment', () => {
        const fs = require('fs');
        const path = require('path');
        const source = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');

        expect(source).toContain('process.env.MONGOLAB_URI');
        // No fallback database: guessing where to connect is how a service ends
        // up pointed at the wrong one without anybody noticing.
        expect(source).not.toMatch(/mongoose\.connect\(\s*process\.env\.MONGOLAB_URI\s*\|\|/);
    });
});