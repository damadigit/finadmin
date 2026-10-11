const db = require('./helpers/db');
const gql = require('./helpers/graphql');
const { createUser } = require('./helpers/factories');

const NON_ADMIN_ROLES = ['admin', 'handler', 'sponsor', 'etAdmin', 'beAdmin', 'finance', 'financeAdmin'];

// Every role that is not a super-admin, including the finance roles and, since
// the handover closed, the administrator role.
//
// The finance boundary and the user-management boundary are separate on purpose.
// A payment role is trusted with bank details and allowances; being trusted with
// those does not make somebody the person who decides who else is trusted. The
// same reasoning is why 'admin' is here: deciding what happens to beneficiary
// records is not deciding who else is trusted.
describe('account administration', () => {
    let schema;

    beforeAll(async () => {
        await db.connect();
        db.loadModels();
        schema = db.getSchema();
    });

    afterAll(async () => {
        await db.disconnect();
    });

    beforeEach(async () => {
        await db.clearDatabase();
    });

    const reads = [
        '{ allUsers { id email } }',
        '{ _allUsersMeta { count } }',
        '{ oneUser(filter: { email: "anyone@example.com" }) { id } }',
    ];

    // `roles` is no longer writable through any composed user input - role
    // assignment moved to the guarded setUserRoles mutation so that it can
    // enforce the rules about the last super-admin. These writes therefore use
    // `email`, which is still composed, so what is under test is the GUARD and
    // not the absence of a field. test/userManagementAccess.test.js covers the
    // role path itself.
    const writes = [
        {
            mutation: `
                mutation updateUser($record: UpdateByIdUserInput!) {
                    updateUser(record: $record) { record { id email } }
                }
            `,
            variables: { record: { _id: '507f1f77bcf86cd799439011', email: 'taken@example.com' } },
        },
        {
            mutation: `
                mutation deleteUser($_id: MongoID!) {
                    deleteUser(_id: $_id) { recordId }
                }
            `,
            variables: { _id: '507f1f77bcf86cd799439011' },
        },
        {
            mutation: `
                mutation updateOneUser($filter: FilterUpdateOneUserInput!, $record: UpdateOneUserInput!) {
                    updateOneUser(filter: $filter, record: $record) { record { id } }
                }
            `,
            variables: { filter: { email: 'someone@example.com' }, record: { email: 'taken@example.com' } },
        },
    ];

    describe('reads', () => {
        it('refuses every role outside the admin boundary', async () => {
            for (const role of NON_ADMIN_ROLES) {
                const user = await createUser({ roles: [role] });
                for (const query of reads) {
                    await expect(gql.run(schema, query, { user })).rejects.toThrow(/Forbidden/);
                }
            }
        });

        it('refuses an unauthenticated caller', async () => {
            for (const query of reads) {
                await expect(gql.run(schema, query)).rejects.toThrow(/Forbidden/);
            }
        });

        it('allows a super-admin', async () => {
            const user = await createUser({ roles: ['superAdmin'] });
            await expect(gql.run(schema, '{ allUsers { id email } }', { user })).resolves.toBeTruthy();
        });
    });

    describe('writes', () => {
        it('refuses every role outside the admin boundary', async () => {
            for (const role of NON_ADMIN_ROLES) {
                const user = await createUser({ roles: [role] });
                for (const { mutation, variables } of writes) {
                    await expect(
                        gql.run(schema, mutation, { user, variables })
                    ).rejects.toThrow(/Forbidden/);
                }
            }
        });

        it('allows a super-admin to change an email', async () => {
            const superAdmin = await createUser({ roles: ['superAdmin'] });
            const applicant = await createUser({ roles: ['handler'], email: 'applicant@example.com' });

            const data = await gql.run(schema, writes[0].mutation, {
                user: superAdmin,
                variables: { record: { _id: String(applicant._id), email: 'renamed@example.com' } },
            });

            expect(data.updateUser.record.email).toBe('renamed@example.com');
        });
    });

    // Account creation stays on the registration path, which hashes the password
    // and assigns the least privileged role. It used to be a GraphQL mutation too,
    // reachable by anyone, which meant anyone could mint an account with any role
    // in a single request.
    describe('account creation', () => {
        it('offers no way to create an account with a chosen password', () => {
            const mutations = Object.keys(schema.getMutationType().getFields());

            expect(mutations).not.toContain('createUser');
            expect(mutations).not.toContain('createManyUser');
        });
    });

    // The specific abuse this guard exists to stop. Composed unguarded, these
    // three calls were enough to take over the installation from a low-privilege
    // account, and a role change made that way is invisible to every other guard
    // in the system because the attacker is now legitimately a financeAdmin.
    //
    // Two independent defences now stand in the way. `roles` is not a field on
    // any composed user input, so the promotion simply cannot be expressed; and
    // for any write that does exist, the guard refuses a caller outside the
    // boundary. Both are asserted, because either alone would be a thinner
    // guarantee than the one being replaced.
    describe('escalation', () => {
        it('cannot express a role promotion through the composed path at all', async () => {
            const attacker = await createUser({ roles: ['handler'], email: 'attacker@example.com' });

            await expect(
                gql.run(schema,
                    'mutation($r: UpdateByIdUserInput!) { updateUser(record: $r) { record { id } } }',
                    { user: attacker, variables: { r: { _id: String(attacker._id), roles: ['financeAdmin'] } } }
                )
            ).rejects.toThrow(/roles/);
        });

        it('stops a user changing their own account', async () => {
            const attacker = await createUser({ roles: ['handler'], email: 'attacker@example.com' });
            const emailBefore = attacker.email;

            await expect(
                gql.run(schema, writes[0].mutation, {
                    user: attacker,
                    variables: { record: { _id: String(attacker._id), email: 'attacker2@example.com' } },
                })
            ).rejects.toThrow(/Forbidden/);

            const unchanged = await db.mongoose.model('User').findById(attacker._id);
            expect(Array.from(unchanged.roles)).toEqual(['handler']);
            expect(unchanged.email).toBe(emailBefore);
        });

        it('stops a user rewriting another account', async () => {
            const attacker = await createUser({ roles: ['handler'], email: 'attacker@example.com' });
            const victim = await createUser({ roles: ['financeAdmin'], email: 'boss@example.com' });
            const victimBefore = await db.mongoose.model('User').findById(victim._id).select('+password');

            await expect(
                gql.run(schema, writes[2].mutation, {
                    user: attacker,
                    variables: { filter: { email: 'boss@example.com' }, record: { email: 'stolen@example.com' } },
                })
            ).rejects.toThrow(/Forbidden/);

            const victimAfter = await db.mongoose.model('User').findById(victim._id).select('+password');
            expect(Array.from(victimAfter.roles)).toEqual(['financeAdmin']);
            expect(victimAfter.email).toBe('boss@example.com');
            expect(victimAfter.password).toBe(victimBefore.password);
        });

        it('stops a user deleting an administrator', async () => {
            const attacker = await createUser({ roles: ['handler'], email: 'attacker@example.com' });
            await createUser({ roles: ['admin'], email: 'boss@example.com' });

            await expect(
                gql.run(schema, writes[1].mutation, {
                    user: attacker,
                    variables: { _id: '507f1f77bcf86cd799439011' },
                })
            ).rejects.toThrow(/Forbidden/);

            expect(await db.mongoose.model('User').countDocuments({ email: 'boss@example.com' })).toBe(1);
        });
    });

    // Two distinct problems, one field. Reading the hash hands an attacker every
    // account to crack offline; writing it is account takeover whether or not
    // they can read anything.
    describe('the password field', () => {
        it('is not on the User type at all', () => {
            expect(Object.keys(schema.getType('User').getFields())).not.toContain('password');
        });

        it('cannot be read by any caller, super-admin included', async () => {
            const superAdmin = await createUser({ roles: ['superAdmin'] });

            await expect(
                gql.run(schema, '{ allUsers { email password } }', { user: superAdmin })
            ).rejects.toThrow(/Cannot query field "password"/);

            await expect(
                gql.run(schema,
                    'query($id: MongoID!) { oneUser(filter: { _id: $id }) { password } }',
                    { user: superAdmin, variables: { id: String(superAdmin._id) } }
                )
            ).rejects.toThrow(/Cannot query field "password"/);
        });

        it('cannot be written through any user input', async () => {
            const superAdmin = await createUser({ roles: ['superAdmin'] });

            // Setting a password here would let anyone with user management, or
            // anyone who reached this before the guard existed, choose a new
            // credential for an account. Passwords are set at registration and by
            // an explicit password change, which hashes them.
            await expect(
                gql.run(schema,
                    'mutation($r: UpdateByIdUserInput!) { updateUser(record: $r) { record { id } } }',
                    { user: superAdmin, variables: { r: { _id: String(superAdmin._id), password: 'chosen-by-caller' } } }
                )
            ).rejects.toThrow(/password/);
        });
    });

    it('leaves the rest of the application alone', async () => {
        // A guard on accounts must not stop finance doing finance, or the
        // payments feature would depend on holding the admin role as well.
        const finance = await createUser({ roles: ['financeAdmin'] });

        await expect(
            gql.run(schema, '{ allAccountHolders { id } }', { user: finance })
        ).resolves.toBeTruthy();
    });
});