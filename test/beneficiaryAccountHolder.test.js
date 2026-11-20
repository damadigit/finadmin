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

        it('unlinks its beneficiaries and then deletes the holder', async () => {
            const shared = await holder();
            const hana = await createRecord({ name: 'Hana', accountHolder: shared._id });
            const sara = await createRecord({ name: 'Sara', accountHolder: shared._id });

            const data = await gql.run(schema, deleteHolder, {
                user, variables: { _id: shared._id.toString() },
            });

            expect(data.deleteAccountHolder.recordId).toBe(shared._id.toString());
            expect(await AccountHolder.countDocuments({})).toBe(0);

            // The beneficiaries themselves are kept, only the link is cleared.
            expect(await Record.countDocuments({})).toBe(2);
            expect(await Record.countDocuments({ accountHolder: { $in: [shared._id] } })).toBe(0);

            const detached = await Record.find({ _id: { $in: [hana._id, sara._id] } });
            detached.forEach(record => expect(record.accountHolder).toBeUndefined());
        });

        it('leaves other holders and their beneficiaries alone', async () => {
            const removed = await holder({ name: 'Removed' });
            const kept = await holder({ name: 'Kept' });
            const removedRecord = await createRecord({ name: 'Hana', accountHolder: removed._id });
            const keptRecord = await createRecord({ name: 'Sara', accountHolder: kept._id });

            await gql.run(schema, deleteHolder, { user, variables: { _id: removed._id.toString() } });

            expect(await AccountHolder.countDocuments({})).toBe(1);
            expect((await Record.findById(removedRecord._id)).accountHolder).toBeUndefined();
            expect((await Record.findById(keptRecord._id)).accountHolder.toString()).toBe(kept._id.toString());
        });

        it('allows deleting a holder that was never linked', async () => {
            const spare = await holder({ name: 'Spare' });

            await gql.run(schema, deleteHolder, { user, variables: { _id: spare._id.toString() } });

            expect(await AccountHolder.countDocuments({})).toBe(0);
        });

        it('unlinks the beneficiaries of every holder in a bulk delete', async () => {
            const linked = await holder({ name: 'Linked' });
            await holder({ name: 'Spare' });
            const record = await createRecord({ name: 'Hana', accountHolder: linked._id });

            const bulkDelete = `
                mutation deleteManyAccountHolder($filter: FilterRemoveManyAccountHolderInput!) {
                    deleteManyAccountHolder(filter: $filter) { numAffected }
                }
            `;

            const data = await gql.run(schema, bulkDelete, {
                user, variables: { filter: { name: 'Linked' } },
            });

            expect(data.deleteManyAccountHolder.numAffected).toBe(1);
            expect(await AccountHolder.countDocuments({})).toBe(1);
            expect(await Record.countDocuments({ accountHolder: linked._id })).toBe(0);
            expect((await Record.findById(record._id)).accountHolder).toBeUndefined();
        });

        it('unlinks beneficiaries for a bulk delete by id', async () => {
            const shared = await holder({ name: 'Shared' });
            await createRecord({ name: 'Hana', accountHolder: shared._id });

            const bulkDeleteByIds = `
                mutation deleteManyAccountHolder($filter: FilterRemoveManyAccountHolderInput!) {
                    deleteManyAccountHolder(filter: $filter) { numAffected }
                }
            `;

            const data = await gql.run(schema, bulkDeleteByIds, {
                user, variables: { filter: { _ids: [shared._id.toString()] } },
            });

            expect(data.deleteManyAccountHolder.numAffected).toBe(1);
            expect(await Record.countDocuments({ accountHolder: shared._id })).toBe(0);
        });
    });
});