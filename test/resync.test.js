const db = require('./helpers/db');
const gql = require('./helpers/graphql');
const { createUser, createRecord } = require('./helpers/factories');

describe('re-syncing a draft month', () => {
    let schema;
    let finance;
    let financeAdmin;
    let Record;
    let AccountHolder;
    let PaymentPeriod;

    beforeAll(async () => {
        await db.connect();
        db.loadModels();
        schema = db.getSchema();
        Record = db.mongoose.model('Record');
        AccountHolder = db.mongoose.model('AccountHolder');
        PaymentPeriod = db.mongoose.model('PaymentPeriod');
    });

    afterAll(async () => {
        await db.disconnect();
    });

    beforeEach(async () => {
        await db.clearDatabase();
        finance = await createUser({ roles: ['finance'] });
        financeAdmin = await createUser({ roles: ['financeAdmin'] });
    });

    const setAllowance = `
        mutation setMonthlyAllowance($record: SetMonthlyAllowanceInput!) {
            setMonthlyAllowance(record: $record) { monthlyAllowance }
        }`;
    const generate = 'mutation g($record: GeneratePaymentPeriodInput!) { generatePaymentPeriod(record: $record) { id } }';
    const setRow = 'mutation setPayoutRow($record: SetPayoutRowInput!) { setPayoutRow(record: $record) { updated } }';
    const preview = `
        query p($record: PaymentMonthInput!) {
            previewPaymentPeriodResync(record: $record) {
                added { record registrationId amount included }
                removedCount heldForReviewCount unchangedCount
            }
        }`;
    const resync = 'mutation r($record: PaymentMonthInput!) { resyncPaymentPeriod(record: $record) { month status } }';
    const readRows = `
        query m($month: String!) {
            paymentMonth(month: $month) {
                rows { record registrationId amount included note bankName accountNumber bankDetailsChanged }
            }
        }`;

    const allow = (record, amount) => gql.run(schema, setAllowance, {
        user: finance, variables: { record: { id: String(record._id), amount } },
    });
    const edit = (record, changes) => gql.run(schema, setRow, {
        user: finance, variables: { record: { month: '2026-08', record: String(record._id), ...changes } },
    });
    const rows = async () => (await gql.run(schema, readRows, {
        user: finance, variables: { month: '2026-08' },
    })).paymentMonth.rows;

    const beneficiary = async (registrationId, amount, holder) => {
        const record = await createRecord({ registrationId });
        record.accountHolder = holder._id;
        await record.save();
        await allow(record, amount);
        return record;
    };

    const startMonth = async () => {
        const holder = await AccountHolder.create({
            name: 'Almaz', banks: [{ bankName: 'CBE', accountNumber: '1000' }],
        });
        await beneficiary('ET-0001', 500, holder);
        await gql.run(schema, generate, { user: finance, variables: { record: { month: '2026-08' } } });
        return holder;
    };

    it('picks up a beneficiary who gained an allowance after generation', async () => {
        const holder = await startMonth();
        await beneficiary('ET-0002', 300, holder);

        const plan = await gql.run(schema, preview, { user: finance, variables: { record: { month: '2026-08' } } });
        expect(plan.previewPaymentPeriodResync.added.map(r => r.registrationId)).toEqual(['ET-0002']);
        expect(plan.previewPaymentPeriodResync.unchangedCount).toBe(1);

        await gql.run(schema, resync, { user: finance, variables: { record: { month: '2026-08' } } });

        expect((await rows()).map(r => r.registrationId).sort()).toEqual(['ET-0001', 'ET-0002']);
    });

    it('shows what it would do without doing any of it', async () => {
        const holder = await startMonth();
        await beneficiary('ET-0002', 300, holder);

        await gql.run(schema, preview, { user: finance, variables: { record: { month: '2026-08' } } });

        expect((await rows()).map(r => r.registrationId)).toEqual(['ET-0001']);
    });

    it('leaves a tick, an amount and a note exactly as finance set them', async () => {
        const holder = await startMonth();
        const first = await Record.findOne({ registrationId: 'ET-0001' });
        await edit(first, { included: false, note: 'left the area', amount: 0 });

        await beneficiary('ET-0002', 300, holder);
        await gql.run(schema, resync, { user: finance, variables: { record: { month: '2026-08' } } });

        const kept = (await rows()).find(r => r.registrationId === 'ET-0001');
        expect(kept).toMatchObject({ included: false, note: 'left the area', amount: 0 });
    });

    it('removes a beneficiary who dropped off, untouched by finance', async () => {
        const holder = await AccountHolder.create({ name: 'Almaz', banks: [{ bankName: 'CBE', accountNumber: '1000' }] });
        await beneficiary('ET-0001', 500, holder);
        const dropped = await beneficiary('ET-0002', 300, holder);
        await gql.run(schema, generate, { user: finance, variables: { record: { month: '2026-08' } } });

        // The allowance is withdrawn after the month was generated.
        await allow(dropped, 0);

        const plan = await gql.run(schema, preview, { user: finance, variables: { record: { month: '2026-08' } } });
        expect(plan.previewPaymentPeriodResync.removedCount).toBe(1);
        expect(plan.previewPaymentPeriodResync.heldForReviewCount).toBe(0);

        await gql.run(schema, resync, { user: finance, variables: { record: { month: '2026-08' } } });

        expect((await rows()).map(r => r.registrationId)).toEqual(['ET-0001']);
    });

    it('holds back a dropped row that finance annotated rather than removing it', async () => {
        const holder = await AccountHolder.create({ name: 'Almaz', banks: [{ bankName: 'CBE', accountNumber: '1000' }] });
        const first = await beneficiary('ET-0001', 500, holder);
        const second = await beneficiary('ET-0002', 300, holder);
        await gql.run(schema, generate, { user: finance, variables: { record: { month: '2026-08' } } });

        await edit(second, { note: 'pending documents' });
        await allow(second, 0);

        const plan = await gql.run(schema, preview, { user: finance, variables: { record: { month: '2026-08' } } });
        expect(plan.previewPaymentPeriodResync.heldForReviewCount).toBe(1);
        expect(plan.previewPaymentPeriodResync.removedCount).toBe(0);

        await gql.run(schema, resync, { user: finance, variables: { record: { month: '2026-08' } } });

        const after = await rows();
        expect(after.map(r => r.registrationId).sort()).toEqual(['ET-0001', 'ET-0002']);
        expect(after.find(r => r.registrationId === 'ET-0002').note).toBe('pending documents');
    });

    it('does nothing when nothing has changed', async () => {
        await startMonth();

        const plan = await gql.run(schema, preview, { user: finance, variables: { record: { month: '2026-08' } } });
        expect(plan.previewPaymentPeriodResync).toMatchObject({
            added: [], removedCount: 0, heldForReviewCount: 0, unchangedCount: 1,
        });
    });

    it('takes up a corrected bank account, clearing the drift flag', async () => {
        const holder = await startMonth();

        // The generated row snapshots the account as it was.
        let row = (await rows()).find(r => r.registrationId === 'ET-0001');
        expect(row.accountNumber).toBe('1000');
        expect(row.bankDetailsChanged).toBe(false);

        // The account number is corrected after generation: the snapshot no
        // longer matches, so reading flags the drift.
        holder.banks = [{ bankName: 'CBE', accountNumber: '2000' }];
        await holder.save();

        row = (await rows()).find(r => r.registrationId === 'ET-0001');
        expect(row.accountNumber).toBe('1000');
        expect(row.bankDetailsChanged).toBe(true);

        // Re-sync is the draft-only action that picks the correction up.
        await gql.run(schema, resync, { user: finance, variables: { record: { month: '2026-08' } } });

        row = (await rows()).find(r => r.registrationId === 'ET-0001');
        expect(row.accountNumber).toBe('2000');
        expect(row.bankDetailsChanged).toBe(false);
    });

    it('refuses on a month that is no longer a draft', async () => {
        await startMonth();
        await gql.run(schema, 'mutation a($month: String!) { approvePaymentPeriod(month: $month) { status } }',
            { user: financeAdmin, variables: { month: '2026-08' } });

        await expect(
            gql.run(schema, preview, { user: finance, variables: { record: { month: '2026-08' } } })
        ).rejects.toThrow(/Only a draft month/);

        await expect(
            gql.run(schema, resync, { user: finance, variables: { record: { month: '2026-08' } } })
        ).rejects.toThrow(/Only a draft month/);
    });

    it('refuses roles outside the finance boundary', async () => {
        await startMonth();
        const admin = await createUser({ roles: ['admin'] });

        await expect(
            gql.run(schema, preview, { user: admin, variables: { record: { month: '2026-08' } } })
        ).rejects.toThrow(/Forbidden/);
        await expect(
            gql.run(schema, resync, { user: admin, variables: { record: { month: '2026-08' } } })
        ).rejects.toThrow(/Forbidden/);
    });
});