const db = require('./helpers/db');
const gql = require('./helpers/graphql');
const { createUser } = require('./helpers/factories');

// comparePassword is callback-only, as written in the model.
const verifies = (user, password) => new Promise((resolve, reject) => {
    user.comparePassword(password, (err, isMatch) => (err ? reject(err) : resolve(isMatch)));
});

// Roles that are outside the user-management boundary.
//
// 'admin' is in here. It was briefly admitted while the handover was open - no
// superAdmin account existed, and without one nobody could reach the page that
// appoints the first. A superAdmin now exists, so an administrator is refused
// again. That is the whole point of the split: an administrator decides what
// happens to beneficiary records, not who else is trusted.
const NON_USER_MANAGEMENT_ROLES = [
    'admin', 'handler', 'sponsor', 'etAdmin', 'beAdmin', 'finance', 'financeAdmin',
];

// The handover, and its ending, in one place. The boundary is a single constant
// on each side of the repository, so if 'admin' is ever re-admitted this file is
// what says so out loud.
describe('user management', () => {
    let schema;
    let User;

    beforeAll(async () => {
        await db.connect();
        db.loadModels();
        schema = db.getSchema();
        User = db.mongoose.model('User');
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

    const setRoles = `
        mutation setUserRoles($userId: MongoID!, $roles: [String!]!) {
            setUserRoles(userId: $userId, roles: $roles) { id roles }
        }
    `;

    const createAccount = `
        mutation createUserAccount($email: String!, $password: String!, $roles: [String!]) {
            createUserAccount(email: $email, password: $password, roles: $roles) { id email roles }
        }
    `;

    const deleteUser = `
        mutation deleteUser($_id: MongoID!) {
            deleteUser(_id: $_id) { recordId }
        }
    `;

    const deleteOneUser = `
        mutation deleteOneUser($filter: FilterRemoveOneUserInput!) {
            deleteOneUser(filter: $filter) { recordId }
        }
    `;

    const deleteManyUsers = `
        mutation deleteManyUser($filter: FilterRemoveManyUserInput!) {
            deleteManyUser(filter: $filter) { numAffected }
        }
    `;

    describe('access', () => {
        it('refuses every role outside the boundary, on reads and on both new mutations', async () => {
            for (const role of NON_USER_MANAGEMENT_ROLES) {
                const user = await createUser({ roles: [role] });
                const target = await createUser({ email: `target-${role}@example.com` });

                for (const query of reads) {
                    await expect(gql.run(schema, query, { user })).rejects.toThrow(/Forbidden/);
                }

                await expect(
                    gql.run(schema, setRoles, {
                        user,
                        variables: { userId: String(target._id), roles: ['financeAdmin'] },
                    })
                ).rejects.toThrow(/Forbidden/);

                await expect(
                    gql.run(schema, createAccount, {
                        user,
                        variables: { email: `made-by-${role}@example.com`, password: 'a-long-enough-one' },
                    })
                ).rejects.toThrow(/Forbidden/);

                await expect(
                    gql.run(schema, deleteUser, { user, variables: { _id: String(target._id) } })
                ).rejects.toThrow(/Forbidden/);
            }
        });

        it('refuses an unauthenticated caller', async () => {
            for (const query of reads) {
                await expect(gql.run(schema, query)).rejects.toThrow(/Forbidden/);
            }

            const target = await createUser({ email: 'target@example.com' });

            await expect(
                gql.run(schema, createAccount, {
                    variables: { email: 'anon@example.com', password: 'a-long-enough-one' },
                })
            ).rejects.toThrow(/Forbidden/);

            await expect(
                gql.run(schema, setRoles, {
                    variables: { userId: String(target._id), roles: ['financeAdmin'] },
                })
            ).rejects.toThrow(/Forbidden/);

            await expect(
                gql.run(schema, deleteUser, { variables: { _id: String(target._id) } })
            ).rejects.toThrow(/Forbidden/);

            await expect(
                gql.run(schema, deleteManyUsers, { variables: { filter: { email: 'target@example.com' } } })
            ).rejects.toThrow(/Forbidden/);

            expect(await User.countDocuments({ email: 'target@example.com' })).toBe(1);
        });

        it('allows a super-admin', async () => {
            const superAdmin = await createUser({ roles: ['superAdmin'] });
            const target = await createUser({ email: 'someone@example.com' });

            await expect(
                gql.run(schema, '{ allUsers { id email } }', { user: superAdmin })
            ).resolves.toBeTruthy();

            const data = await gql.run(schema, setRoles, {
                user: superAdmin,
                variables: { userId: String(target._id), roles: ['finance'] },
            });
            expect(data.setUserRoles.roles).toEqual(['finance']);
        });

        // The handover is closed. An administrator reaching user management
        // again would mean the boundary had been reopened, so this asserts the
        // refusal rather than leaving it to the loop above, which would pass
        // just as happily if 'admin' were quietly dropped from the list.
        it('refuses an administrator now the handover is closed', async () => {
            const admin = await createUser({ roles: ['admin'] });

            await expect(
                gql.run(schema, '{ allUsers { id email } }', { user: admin })
            ).rejects.toThrow(/Forbidden/);

            await expect(
                gql.run(schema, createAccount, {
                    user: admin,
                    variables: { email: 'by-admin@example.com', password: 'a-long-enough-one' },
                })
            ).rejects.toThrow(/Forbidden/);
        });
    });

    // Granting super-admin is itself a user-management action. Strip it from
    // every account and nobody is left who can put it back - the feature that
    // repairs it is the feature that was switched off.
    //
    // On the setUserRoles path the count rule is now unreachable, and it is worth
    // saying why rather than pretending otherwise: to remove superAdmin from a
    // target the caller must be a superAdmin other than the target (self-demotion
    // is refused first), so a second superAdmin necessarily exists and the count
    // can never reach zero. The rule is kept as a second line of defence for any
    // future relaxation of self-demotion, and it is unit-tested directly in
    // test/roleLifecycle.test.js. What is tested here is what a caller can
    // actually reach.
    describe('the last super-admin', () => {
        it('lets a super-admin demote another while one remains', async () => {
            const actor = await createUser({ roles: ['superAdmin'] });
            const other = await createUser({ roles: ['superAdmin'], email: 'second@example.com' });

            await expect(
                gql.run(schema, setRoles, {
                    user: actor,
                    variables: { userId: String(other._id), roles: ['admin'] },
                })
            ).resolves.toBeTruthy();

            const demoted = await User.findById(other._id);
            expect(Array.from(demoted.roles)).toEqual(['admin']);
        });

        it('refuses to delete the only super-admin', async () => {
            const superAdmin = await createUser({ roles: ['superAdmin'] });

            await expect(
                gql.run(schema, deleteUser, { user: superAdmin, variables: { _id: String(superAdmin._id) } })
            ).rejects.toThrow(/Appoint another super-admin/);

            expect(await User.countDocuments({ _id: superAdmin._id })).toBe(1);
        });

        it('allows deleting one of two super-admins', async () => {
            const keeper = await createUser({ roles: ['superAdmin'] });
            await createUser({ roles: ['superAdmin'], email: 'leaving@example.com' });

            await expect(
                gql.run(schema, deleteUser, {
                    user: keeper,
                    variables: { _id: (await User.findOne({ email: 'leaving@example.com' }))._id.toString() },
                })
            ).resolves.toBeTruthy();

            expect(await User.countDocuments({ roles: 'superAdmin' })).toBe(1);
        });

        // The guard is the model's deleteGuard, so the bulk paths are covered by
        // the same code. They are the easiest thing to leave open, because a
        // check placed only on a hand-written deleteUser would not touch them.
        //
        // `roles` is an array, so it gets no entry on the remove filters at all;
        // the targets are selected by id instead.
        it('refuses the bulk delete paths too', async () => {
            const superAdmin = await createUser({ roles: ['superAdmin'] });
            await createUser({ email: 'someone-else@example.com' });
            const targetId = String(superAdmin._id);

            await expect(
                gql.run(schema, deleteOneUser, {
                    user: superAdmin,
                    variables: { filter: { _ids: [targetId] } },
                })
            ).rejects.toThrow(/Appoint another super-admin/);

            await expect(
                gql.run(schema, deleteManyUsers, {
                    user: superAdmin,
                    variables: { filter: { _ids: [targetId] } },
                })
            ).rejects.toThrow(/Appoint another super-admin/);

            expect(await User.countDocuments({ _id: superAdmin._id })).toBe(1);

            // An ordinary account is still deletable by the same path, so the
            // guard is refusing the right thing and not simply refusing
            // everything the bulk resolvers are asked to do.
            await expect(
                gql.run(schema, deleteManyUsers, {
                    user: superAdmin,
                    variables: { filter: { email: 'someone-else@example.com' } },
                })
            ).resolves.toBeTruthy();
        });
    });

    // Two super-admins demoting each other in the same sitting still reaches
    // zero, so the count check alone does not cover it.
    describe('self demotion', () => {
        it('refuses to drop super-admin from your own account', async () => {
            const superAdmin = await createUser({ roles: ['superAdmin'] });
            await createUser({ roles: ['superAdmin'], email: 'colleague@example.com' });

            await expect(
                gql.run(schema, setRoles, {
                    user: superAdmin,
                    variables: { userId: String(superAdmin._id), roles: ['admin'] },
                })
            ).rejects.toThrow(/your own account/i);

            const unchanged = await User.findById(superAdmin._id);
            expect(Array.from(unchanged.roles)).toEqual(['superAdmin']);
        });

        it('still allows changing your own other roles', async () => {
            const superAdmin = await createUser({ roles: ['superAdmin', 'finance'] });

            const data = await gql.run(schema, setRoles, {
                user: superAdmin,
                variables: { userId: String(superAdmin._id), roles: ['superAdmin'] },
            });

            expect(data.setUserRoles.roles).toEqual(['superAdmin']);
        });

        // An account with no roles can do nothing at all, which is not least
        // privilege but an account nobody can use. The interface warns about
        // this, but the interface is not what protects the system.
        it('refuses to empty a user of every role', async () => {
            const superAdmin = await createUser({ roles: ['superAdmin'] });
            const target = await createUser({ roles: ['handler'], email: 'target@example.com' });

            await expect(
                gql.run(schema, setRoles, {
                    user: superAdmin,
                    variables: { userId: String(target._id), roles: [] },
                })
            ).rejects.toThrow(/at least one role/i);

            const unchanged = await User.findById(target._id);
            expect(Array.from(unchanged.roles)).toEqual(['handler']);
        });
    });

    // A field that can bypass a hand-written mutation's invariant is an
    // invariant that is not enforced. Both rules above are steppable-around by
    // calling updateUser with a roles field instead, which is exactly the call
    // the existing escalation tests make.
    describe('the composed update path', () => {
        it('cannot set roles through any user input', async () => {
            const superAdmin = await createUser({ roles: ['superAdmin'] });
            const target = await createUser({ email: 'target@example.com' });

            const attempts = [
                ['mutation($r: UpdateByIdUserInput!) { updateUser(record: $r) { record { id } } }',
                    { r: { _id: String(target._id), roles: ['financeAdmin'] } }],
                ['mutation($_id: MongoID!, $r: UpdateOneUserInput!) { updateOneUser(filter: { _id: $_id }, record: $r) { record { id } } }',
                    { _id: String(target._id), r: { roles: ['financeAdmin'] } }],
                ['mutation($_id: MongoID!, $r: UpdateManyUserInput!) { updateManyUser(filter: { _id: $_id }, record: $r) { numAffected } }',
                    { _id: String(target._id), r: { roles: ['financeAdmin'] } }],
            ];

            for (const [mutation, variables] of attempts) {
                await expect(
                    gql.run(schema, mutation, { user: superAdmin, variables })
                ).rejects.toThrow(/roles/);
            }

            const unchanged = await User.findById(target._id);
            expect(Array.from(unchanged.roles)).toEqual(['handler']);
        });

        // The spec names six input types that must not carry `roles`. The three
        // above exercise the three that are reachable as mutations; these three
        // are the filter inputs the resolvers derive their arguments from, and
        // they are asserted directly because nothing else would notice them
        // reappearing.
        it('has no roles field on any user input type', () => {
            const inputTypes = [
                'UpdateByIdUserInput', 'UpdateOneUserInput', 'UpdateManyUserInput',
                'FilterUpdateOneUserInput', 'FilterUpdateManyUserInput',
                'FilterFindOneUserInput',
            ];

            for (const name of inputTypes) {
                const type = schema.getType(name);
                expect(type).toBeTruthy();
                expect(Object.keys(type.getFields())).not.toContain('roles');
            }
        });

        it('still allows changing an email', async () => {
            const superAdmin = await createUser({ roles: ['superAdmin'] });
            const target = await createUser({ email: 'old@example.com' });

            await expect(
                gql.run(schema,
                    'mutation($r: UpdateByIdUserInput!) { updateUser(record: $r) { record { email } } }',
                    { user: superAdmin, variables: { r: { _id: String(target._id), email: 'new@example.com' } } }
                )
            ).resolves.toBeTruthy();

            expect((await User.findById(target._id)).email).toBe('new@example.com');
        });
    });

    // The deliberate re-add of a capability the escalation fix closed. Confined
    // to one guarded mutation - the composed create is still gone.
    describe('creating an account', () => {
        it('creates an account with a hashed password', async () => {
            const superAdmin = await createUser({ roles: ['superAdmin'] });
            const password = 'a-long-enough-one';

            const data = await gql.run(schema, createAccount, {
                user: superAdmin,
                variables: { email: 'newcomer@example.com', password, roles: ['handler'] },
            });

            expect(data.createUserAccount.email).toBe('newcomer@example.com');
            expect(data.createUserAccount.roles).toEqual(['handler']);

            const created = await User.findOne({ email: 'newcomer@example.com' }).select('+password');
            expect(created.password).not.toBe(password);
            await expect(verifies(created, password)).resolves.toBe(true);
        });

        it('never returns the password', () => {
            expect(Object.keys(schema.getType('CreateUserAccountPayload').getFields()))
                .not.toContain('password');
        });

        it('defaults to the least privileged role', async () => {
            const superAdmin = await createUser({ roles: ['superAdmin'] });

            await gql.run(schema, createAccount, {
                user: superAdmin,
                variables: { email: 'bare@example.com', password: 'a-long-enough-one' },
            });

            const created = await User.findOne({ email: 'bare@example.com' });
            expect(Array.from(created.roles)).toEqual(['handler']);
        });

        it('rejects a role outside the enum', async () => {
            const superAdmin = await createUser({ roles: ['superAdmin'] });

            await expect(
                gql.run(schema, createAccount, {
                    user: superAdmin,
                    variables: {
                        email: 'typo@example.com',
                        password: 'a-long-enough-one',
                        roles: ['financ'],
                    },
                })
            ).rejects.toThrow(/Unknown role/);

            expect(await User.countDocuments({ email: 'typo@example.com' })).toBe(0);
        });

        it('rejects a short password', async () => {
            const superAdmin = await createUser({ roles: ['superAdmin'] });

            await expect(
                gql.run(schema, createAccount, {
                    user: superAdmin,
                    variables: { email: 'weak@example.com', password: 'short' },
                })
            ).rejects.toThrow(/at least/i);

            expect(await User.countDocuments({ email: 'weak@example.com' })).toBe(0);
        });

        // The escalation fix removed this. It must stay removed - re-adding it
        // would put account takeover back on a general write path.
        it('leaves the composed create mutations gone', () => {
            const mutations = Object.keys(schema.getMutationType().getFields());

            expect(mutations).not.toContain('createUser');
            expect(mutations).not.toContain('createManyUser');
        });
    });

    // "Who granted financeAdmin, and when" is the first thing anybody wants after
    // something goes wrong, and it used to be unanswerable: accounts were the one
    // mutable document with no audit fields. An audit trail a caller can write is
    // not an audit trail, so the fields are struck from the composed inputs as
    // well as stamped by the resolvers.
    describe('the audit trail', () => {
        it('records who created an account', async () => {
            const superAdmin = await createUser({ roles: ['superAdmin'] });

            await gql.run(schema, createAccount, {
                user: superAdmin,
                variables: { email: 'newcomer@example.com', password: 'a-long-enough-one' },
            });

            const created = await User.findOne({ email: 'newcomer@example.com' });
            expect(String(created.createdBy)).toBe(String(superAdmin._id));
            expect(String(created.modifiedBy)).toBe(String(superAdmin._id));
        });

        it('records who changed the roles', async () => {
            const superAdmin = await createUser({ roles: ['superAdmin'] });
            const target = await createUser({ roles: ['handler'], email: 'target@example.com' });

            await gql.run(schema, setRoles, {
                user: superAdmin,
                variables: { userId: String(target._id), roles: ['finance'] },
            });

            const changed = await User.findById(target._id);
            expect(String(changed.modifiedBy)).toBe(String(superAdmin._id));
        });

        // The composed update is composed, so it is the authMiddleware in
        // mongooseQL that stamps it rather than anything in this feature.
        //
        // The operation here is NAMED, and that is load-bearing: authMiddleware
        // reads the operation name out of the document and only stamps when it
        // contains 'update' or 'create'. An anonymous mutation would test a shape
        // that never reaches the server in practice - graphDataProvider always
        // emits `mutation updateUser(...)`.
        it('records who changed an email through the composed path', async () => {
            const superAdmin = await createUser({ roles: ['superAdmin'] });
            const target = await createUser({ email: 'target@example.com' });

            await gql.run(schema,
                'mutation updateUser($record: UpdateByIdUserInput!) { updateUser(record: $record) { record { id } } }',
                { user: superAdmin, variables: { record: { _id: String(target._id), email: 'renamed@example.com' } } }
            );

            const changed = await User.findById(target._id);
            expect(changed.email).toBe('renamed@example.com');
            expect(String(changed.modifiedBy)).toBe(String(superAdmin._id));
        });

        // The fields are struck from the composed inputs so a caller cannot write
        // their own version of who did it.
        it('lets no caller write its own audit fields', async () => {
            const superAdmin = await createUser({ roles: ['superAdmin'] });
            const target = await createUser({ email: 'target@example.com' });

            const attempts = [
                ['mutation($r: UpdateByIdUserInput!) { updateUser(record: $r) { record { id } } }',
                    { r: { _id: String(target._id), createdBy: String(superAdmin._id) } }],
                ['mutation($r: UpdateByIdUserInput!) { updateUser(record: $r) { record { id } } }',
                    { r: { _id: String(target._id), modifiedBy: String(target._id) } }],
            ];

            for (const [mutation, variables] of attempts) {
                await expect(
                    gql.run(schema, mutation, { user: superAdmin, variables })
                ).rejects.toThrow(/createdBy|modifiedBy/);
            }

            const type = schema.getType('UpdateByIdUserInput');
            const fields = Object.keys(type.getFields());
            expect(fields).not.toContain('createdBy');
            expect(fields).not.toContain('modifiedBy');
        });
    });

    // The exact queries graphDataProvider builds for the User resource, assembled
    // from helpers/fields.js. They are written out literally rather than derived
    // so that a change on either side of the repository boundary fails here
    // instead of in the browser.
//
// This exists because the checked-in finadmin_ui/src/helpers/schema.json had
    // already drifted once: it still advertised createUser and `password` on
    // every user input after the server had removed them, so the interface was
    // building calls the server refused to serve. Nothing caught it except
    // somebody noticing.
describe('the interface contract', () => {
        let superAdmin;

        beforeEach(async () => {
            superAdmin = await createUser({ roles: ['superAdmin'], email: 'boss@example.com' });
            await createUser({ roles: ['handler'], email: 'aaa@example.com' });
        });

        it('serves the list query, including the sort the list page sends', async () => {
            const data = await gql.run(schema, `
                query allUsers($filter: FilterFindManyUserInput, $sort: SortFindManyUserInput, $skip: Int, $limit: Int) {
                    items: allUsers(filter: $filter, sort: $sort, skip: $skip, limit: $limit) {
                        id
                        email
                        roles
                    }
                    total: _allUsersMeta(filter: $filter) {
                        count
                    }
                }
            `, { user: superAdmin, variables: { sort: 'EMAIL_ASC', skip: 0, limit: 50 } });

            expect(data.total.count).toBe(2);
            expect(data.items).toHaveLength(2);
            expect(data.items[0].email).toBe('aaa@example.com');
        });

        // GET_ONE resolves to the `User` query - the findById resolver - and not to
        // `oneUser`, which is the findOne resolver and takes a `filter` instead.
        // ra-data-graphql maps `[GET_ONE]: resource => resource.name`. So this is
        // the query the show page actually sends, and the one worth pinning:
        // an earlier version of this test asserted `oneUser(filter: ...)`, which
        // passed while proving nothing about the page at all.
        it('serves the show query', async () => {
            const data = await gql.run(schema, `
                query User($id: MongoID!) {
                    User(_id: $id) {
                        id
                        email
                        roles
                    }
                }
            `, { user: superAdmin, variables: { id: String(superAdmin._id) } });

            expect(data.User.email).toBe('boss@example.com');
            expect(data.User.roles).toEqual(['superAdmin']);
        });

        // `id` appears twice because graphDataProvider always adds its own id
        // selection alongside the field list. Legal GraphQL, and worth pinning
        // so that a change to fields.js cannot quietly break the edit page.
        it('serves the edit query', async () => {
            const target = await User.findOne({ email: 'aaa@example.com' });

            const data = await gql.run(schema, `
                mutation updateUser($record: UpdateByIdUserInput!) {
                    updateUser(record: $record) {
                        record {
                            id
                            id
                            email
                        }
                    }
                }
            `, {
                user: superAdmin,
                variables: { record: { _id: String(target._id), email: 'renamed@example.com' } },
            });

            expect(data.updateUser.record.email).toBe('renamed@example.com');
        });

        it('serves the delete query', async () => {
            const target = await User.findOne({ email: 'aaa@example.com' });

            const data = await gql.run(schema, `
                mutation deleteUser($id: MongoID!) {
                    deleteUser(_id: $id) {
                        recordId
                    }
                }
            `, { user: superAdmin, variables: { id: String(target._id) } });

            expect(data.deleteUser.recordId).toBe(String(target._id));
            expect(await User.countDocuments({ _id: target._id })).toBe(0);
        });
    });

    it('leaves the rest of the application alone', async () => {
        // User management must not become a prerequisite for anything else, the
        // same way the finance boundary is independent of the account boundary.
        const finance = await createUser({ roles: ['financeAdmin'] });

        await expect(
            gql.run(schema, '{ allAccountHolders { id } }', { user: finance })
).resolves.toBeTruthy();
        });

        // A guard that cannot see its targets must not wave them through. The
        // remove filters carry `_operators`, `OR` and `AND`, none of which mean
        // anything to a plain find(): passing one straight through matches
        // nothing, finds no targets, returns early, and deletes the last
        // super-admin anyway. This exact call removed the only super-admin in
        // the installation before the guard was made to fail closed.
        it('refuses a delete whose filter it cannot evaluate', async () => {
            const superAdmin = await createUser({ roles: ['superAdmin'] });

            const attempts = [
                deleteOneUser,
                deleteManyUsers,
            ];

            for (const mutation of attempts) {
                await expect(
                    gql.run(schema, mutation, {
                        user: superAdmin,
                        variables: {
                            filter: { _operators: { email: { in: [superAdmin.email] } } },
                        },
                    })
                ).rejects.toThrow(/cannot see through it/i);
            }

            expect(await User.countDocuments({ _id: superAdmin._id })).toBe(1);

            // OR is the same shape of trick.
            await expect(
                gql.run(schema, deleteManyUsers, {
                    user: superAdmin,
                    variables: { filter: { OR: [{ email: superAdmin.email }] } },
                })
            ).rejects.toThrow(/cannot see through it/i);

            expect(await User.countDocuments({ _id: superAdmin._id })).toBe(1);
        });
});