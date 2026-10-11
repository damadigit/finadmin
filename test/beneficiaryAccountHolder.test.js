const db = require('./helpers/db');
const gql = require('./helpers/graphql');
const { createUser, createRecord } = require('./helpers/factories');

describe('beneficiaries and account holders', () => {
    let schema;
    let user;
    let Record;
    let AccountHolder;

    beforeAll(async () => {
        await db.connect();
        db.loadModels();
        schema = db.getSchema();
        Record = db.mongoose.model('Record');
        AccountHolder = db.mongoose.model('AccountHolder');
    });

    afterAll(async () => {
        await db.disconnect();
    });

    beforeEach(async () => {
        await db.clearDatabase();
        user = await createUser({ roles: ['finance'] });
    });

    const holder = async (overrides = {}) =>
        AccountHolder.create({ name: 'Almaz', banks: [], ...overrides });

    it('links one account holder to several beneficiaries', async () => {
        const shared = await holder({ name: 'Almaz' });

        await createRecord({ name: 'Hana', accountHolder: shared._id });
        await createRecord({ name: 'Sara', accountHolder: shared._id });

        const linked = await Record.find({ accountHolder: shared._id }).select('name');
        expect(linked.map(r => r.name).sort()).toEqual(['Hana', 'Sara']);
    });

    it('exposes the holder as an id only, never its bank details', async () => {
        // Record is not finance-guarded. If this reference expanded, every role
        // that can read a beneficiary could read their parent's bank account.
        const shared = await holder({ name: 'Almaz', banks: [{ bankName: 'CBE', accountNumber: '1' }] });
        const record = await createRecord({ name: 'Hana', accountHolder: shared._id });

        const data = await gql.run(
            schema,
            'query holderLink($id: MongoID!) { Record(_id: $id) { id name accountHolder } }',
            { user, variables: { id: record._id.toString() } }
        );

        expect(data.Record.accountHolder).toBe(shared._id.toString());
    });

    it('still resolves the holder through the guarded operations', async () => {
        const shared = await holder({ name: 'Almaz', banks: [{ bankName: 'CBE', accountNumber: '1' }] });
        await createRecord({ name: 'Hana', accountHolder: shared._id });

        const data = await gql.run(
            schema,
            'query guardedHolder($id: MongoID!) { AccountHolder(_id: $id) { id name banks { bankName accountNumber } } }',
            { user, variables: { id: shared._id.toString() } }
        );

        expect(data.AccountHolder).toMatchObject({
            name: 'Almaz',
            banks: [{ bankName: 'CBE', accountNumber: '1' }],
        });
    });

    it('detaches a beneficiary by clearing the link', async () => {
        const shared = await holder();
        const record = await createRecord({ accountHolder: shared._id });

        record.accountHolder = undefined;
        await record.save();

        expect(await Record.countDocuments({ accountHolder: shared._id })).toBe(0);
    });

    it('leaves bank details off the beneficiary', async () => {
        const record = await createRecord();

        expect(record.bankAccount).toBeUndefined();
        expect(record.banks).toBeUndefined();
        expect(Record.schema.path('accountHolder')).toBeTruthy();
    });

    describe('deleting a holder that is still linked', () => {
        const deleteHolder = `
            mutation deleteAccountHolder($_id: MongoID!) {
                deleteAccountHolder(_id: $_id) { recordId }
            }
        `;

        it('refuses and says how many are still linked', async () => {
            const shared = await holder();
            await createRecord({ accountHolder: shared._id });

            await expect(
                gql.run(schema, deleteHolder, { user, variables: { _id: shared._id.toString() } })
            ).rejects.toThrow(/still linked/);
        });

        it('allows the delete once every beneficiary is detached', async () => {
            const shared = await holder();
            const record = await createRecord({ accountHolder: shared._id });

            await record.updateOne({ accountHolder: undefined });
            await gql.run(schema, deleteHolder, { user, variables: { _id: shared._id.toString() } });

            expect(await AccountHolder.countDocuments({})).toBe(0);
        });

        it('allows deleting a holder that was never linked', async () => {
            const spare = await holder({ name: 'Spare' });

            await gql.run(schema, deleteHolder, { user, variables: { _id: spare._id.toString() } });

            expect(await AccountHolder.countDocuments({})).toBe(0);
        });

        it('refuses a bulk delete that would orphan a beneficiary', async () => {
            const shared = await holder({ name: 'Linked' });
            await holder({ name: 'Spare' });
            await createRecord({ accountHolder: shared._id });

            const bulkDelete = `
                mutation deleteManyAccountHolder($filter: FilterRemoveManyAccountHolderInput!) {
                    deleteManyAccountHolder(filter: $filter) { numAffected }
                }
            `;

            await expect(
                gql.run(schema, bulkDelete, { user, variables: { filter: { name: 'Linked' } } })
            ).rejects.toThrow(/still linked/);

            expect(await AccountHolder.countDocuments({})).toBe(2);

            // The unlinked holder goes through on the same filter.
            const spared = await gql.run(schema, bulkDelete, {
                user, variables: { filter: { name: 'Spare' } },
            });
            expect(spared.deleteManyAccountHolder.numAffected).toBe(1);
            expect(await AccountHolder.countDocuments({})).toBe(1);
        });
    });
});