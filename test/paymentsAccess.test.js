const db = require('./helpers/db');
const gql = require('./helpers/graphql');
const { createUser, createRecord } = require('./helpers/factories');

const NON_FINANCE_ROLES = ['admin', 'handler', 'sponsor', 'etAdmin', 'beAdmin'];

describe('payments access control', () => {
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
        '{ allAccountHolders { id name } }',
        '{ _allAccountHoldersMeta { count } }',
        '{ allPaymentPeriods { id month } }',
        '{ oneAccountHolder(filter: { name: "anyone" }) { id } }',
    ];

    // Each carries its own variables: GraphQL validates variables before a
    // resolver runs, so a mutation missing its required input would fail for the
    // wrong reason and never reach the guard.
    const writes = [
        {
            mutation: `
                mutation createAccountHolder($record: CreateOneAccountHolderInput!) {
                    createAccountHolder(record: $record) { record { id } }
                }
            `,
            variables: { record: { name: 'X' } },
        },
        {
            mutation: `
                mutation updateAccountHolder($record: UpdateByIdAccountHolderInput!) {
                    updateAccountHolder(record: $record) { record { id } }
                }
            `,
            variables: { record: { _id: '507f1f77bcf86cd799439011', name: 'X' } },
        },
        {
            mutation: `
                mutation deleteAccountHolder($_id: MongoID!) {
                    deleteAccountHolder(_id: $_id) { recordId }
                }
            `,
            variables: { _id: '507f1f77bcf86cd799439011' },
        },
        {
            mutation: `
                mutation createPaymentPeriod($record: CreateOnePaymentPeriodInput!) {
                    createPaymentPeriod(record: $record) { record { id } }
                }
            `,
            variables: { record: { month: '2026-08', label: 'August 2026' } },
        },
    ];

    describe('reads', () => {
        it('refuses every role outside the finance boundary', async () => {
            for (const role of NON_FINANCE_ROLES) {
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

        it('allows both finance roles', async () => {
            for (const role of ['finance', 'financeAdmin']) {
                const user = await createUser({ roles: [role] });
                await expect(gql.run(schema, '{ allAccountHolders { id } }', { user })).resolves.toBeTruthy();
                await expect(gql.run(schema, '{ allPaymentPeriods { id } }', { user })).resolves.toBeTruthy();
            }
        });

        it('allows a user who holds a finance role alongside others', async () => {
            const user = await createUser({ roles: ['handler', 'finance'] });
            await expect(gql.run(schema, '{ allAccountHolders { id } }', { user })).resolves.toBeTruthy();
        });
    });

    describe('writes', () => {
        it('refuses every role outside the finance boundary', async () => {
            for (const role of NON_FINANCE_ROLES) {
                const user = await createUser({ roles: [role] });
                for (const { mutation, variables } of writes) {
                    await expect(
                        gql.run(schema, mutation, { user, variables })
                    ).rejects.toThrow(/Forbidden/);
                }
            }
        });

        it('allows both finance roles', async () => {
            for (const role of ['finance', 'financeAdmin']) {
                const user = await createUser({ roles: [role] });
                const data = await gql.run(schema, writes[0].mutation, {
                    user,
                    variables: { record: { name: `Holder ${role}` } },
                });
                expect(data.createAccountHolder.record.id).toBeTruthy();
            }
        });
    });

    it('leaves the rest of the application alone', async () => {
        // The guard is scoped to payment models. An ordinary user must still be
        // able to do ordinary things, or the guard has broken the product.
        const user = await createUser({ roles: ['admin'] });
        await createRecord({ name: 'Hana', registrationId: 'ET-0001' });

        const data = await gql.run(schema, '{ allRecords { id name } }', { user });

        expect(data.allRecords).toHaveLength(1);
    });
});