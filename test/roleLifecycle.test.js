const {
    ALL_ROLES, isSuperAdmin, assertKnownRoles, assertHasRoles,
    assertSuperAdminRemains, assertNotLastSuperAdmin, assertNotSelfDemotion,
} = require('../server/users/roleLifecycle');

// The rules about roles, tested directly.
//
// roleLifecycle is pure and knows nothing about Mongoose or GraphQL, which is
// why it exists as its own module - the resolvers call into it and let it throw.
// Testing it here rather than only through the resolvers is not a shortcut
// around integration coverage; it is the only way to reach one of the rules.
//
// assertSuperAdminRemains, in particular, is unreachable through setUserRoles
// once the handover closes: to strip superAdmin from a target the caller must be
// a different superAdmin (self-demotion is refused first), so a second
// superAdmin always exists and the count can never reach zero. It is kept as a
// second line of defence should self-demotion ever be relaxed, and this is where
// it is actually held to account.
describe('role rules', () => {
    describe('isSuperAdmin', () => {
        it('is true only when the role is present', () => {
            expect(isSuperAdmin(['superAdmin'])).toBe(true);
            expect(isSuperAdmin(['superAdmin', 'finance'])).toBe(true);
            expect(isSuperAdmin(['admin'])).toBe(false);
            expect(isSuperAdmin([])).toBe(false);
        });

        it('survives a missing or malformed role list', () => {
            expect(isSuperAdmin(undefined)).toBe(false);
            expect(isSuperAdmin(null)).toBe(false);
            expect(isSuperAdmin('superAdmin')).toBe(false);
        });
    });

    describe('assertKnownRoles', () => {
        it('accepts every role the model defines', () => {
            expect(() => assertKnownRoles(ALL_ROLES)).not.toThrow();
        });

        it('names the offending role rather than failing obscurely', () => {
            // The typo people actually make, since the role is spelt superAdmin
            // and not super-admin.
            expect(() => assertKnownRoles(['super-admin'])).toThrow(/Unknown role: super-admin/);
            expect(() => assertKnownRoles(['financ'])).toThrow(/Unknown role: financ/);
        });

        it('accepts an empty list, which is a different rule', () => {
            expect(() => assertKnownRoles([])).not.toThrow();
        });
    });

    describe('assertHasRoles', () => {
        it('refuses an account with no roles at all', () => {
            expect(() => assertHasRoles([])).toThrow(/at least one role/);
            expect(() => assertHasRoles(undefined)).toThrow(/at least one role/);
        });

        it('accepts any non-empty list', () => {
            expect(() => assertHasRoles(['handler'])).not.toThrow();
        });
    });

    describe('assertSuperAdminRemains', () => {
        it('refuses to strip the last superAdmin', () => {
            expect(() => assertSuperAdminRemains({
                currentRoles: ['superAdmin'],
                nextRoles: ['admin'],
                otherSuperAdminCount: 0,
            })).toThrow(/Appoint another super-admin/);
        });

        it('allows it while another superAdmin remains', () => {
            expect(() => assertSuperAdminRemains({
                currentRoles: ['superAdmin'],
                nextRoles: ['admin'],
                otherSuperAdminCount: 1,
            })).not.toThrow();
        });

        it('does not interfere when the target is not a superAdmin', () => {
            expect(() => assertSuperAdminRemains({
                currentRoles: ['handler'],
                nextRoles: ['finance'],
                otherSuperAdminCount: 0,
            })).not.toThrow();
        });

        it('does not fire when superAdmin is being kept', () => {
            expect(() => assertSuperAdminRemains({
                currentRoles: ['superAdmin', 'finance'],
                nextRoles: ['superAdmin'],
                otherSuperAdminCount: 0,
            })).not.toThrow();
        });
    });

    describe('assertNotLastSuperAdmin', () => {
        it('refuses to delete the last superAdmin', () => {
            expect(() => assertNotLastSuperAdmin({
                targetRoles: ['superAdmin'],
                otherSuperAdminCount: 0,
            })).toThrow(/Appoint another super-admin/);
        });

        it('allows deleting one of two', () => {
            expect(() => assertNotLastSuperAdmin({
                targetRoles: ['superAdmin'],
                otherSuperAdminCount: 1,
            })).not.toThrow();
        });

        it('never blocks an ordinary account', () => {
            expect(() => assertNotLastSuperAdmin({
                targetRoles: ['handler'],
                otherSuperAdminCount: 0,
            })).not.toThrow();
        });
    });

    describe('assertNotSelfDemotion', () => {
        const base = {
            actorId: 'aaa',
            targetId: 'aaa',
            currentRoles: ['superAdmin'],
            nextRoles: ['admin'],
        };

        it('refuses to drop superAdmin from your own account', () => {
            expect(() => assertNotSelfDemotion(base)).toThrow(/your own account/);
        });

        it('compares ids as strings, since ObjectIds are not ===', () => {
            // The shape that actually arrives: a Mongoose document id against a
            // plain string. Strict equality would call these different accounts
            // and let the demotion through.
            expect(() => assertNotSelfDemotion({
                actorId: { toString: () => 'aaa' },
                targetId: 'aaa',
                currentRoles: ['superAdmin'],
                nextRoles: ['admin'],
            })).toThrow(/your own account/);
        });

        it('allows demoting somebody else', () => {
            expect(() => assertNotSelfDemotion({ ...base, targetId: 'bbb' })).not.toThrow();
        });

        it('allows changing your own other roles', () => {
            expect(() => assertNotSelfDemotion({
                ...base,
                currentRoles: ['superAdmin', 'finance'],
                nextRoles: ['superAdmin'],
            })).not.toThrow();
        });

        it('does not fire when the account was not a superAdmin', () => {
            expect(() => assertNotSelfDemotion({
                ...base,
                currentRoles: ['admin'],
                nextRoles: ['handler'],
            })).not.toThrow();
        });
    });

    it('spells every role the way the database and the API do', () => {
        // A hyphen would come back from GraphQL as an underscore and desync the
        // interface from the database, which is why the role is superAdmin.
        ALL_ROLES.forEach(role => expect(role).toMatch(/^[A-Za-z]+$/));
    });
});
