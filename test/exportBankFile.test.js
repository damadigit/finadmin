const db = require('./helpers/db');
const gql = require('./helpers/graphql');
const { createUser, createRecord } = require('./helpers/factories');
const { STATUS } = require('../server/payments/monthLifecycle');

const NON_FINANCE_ROLES = ['admin', 'handler', 'sponsor', 'etAdmin', 'beAdmin'];

describe('taking a bank file', () => {
    let schema;
    let finance;
    let financeAdmin;
    let AccountHolder;
    let PaymentPeriod;

    beforeAll(async () => {
        await db.connect();
        db.loadModels();
        schema = db.getSchema();
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

    const exportFile = `
        mutation exportBankFile($record: ExportBankFileInput!) {
            exportBankFile(record: $record) { month bankName filename contents lineCount }
        }`;

    // Builds a month with the given rows, already approved.
    const approvedMonth = async (rows, month = '2026-08') => {
        const monthDoc = await PaymentPeriod.create({
            month,
            label: 'August 2026',
            status: STATUS.DRAFT,
            rows,
            createdBy: finance._id,
        });

        // Approve through the real mutation rather than setting the field, so
        // the guard and the approval rules are exercised on the way past.
        await gql.run(schema, 'mutation a($month: String!) { approvePaymentPeriod(month: $month) { status } }', {
            user: financeAdmin, variables: { month },
        });

        return monthDoc;
    };

    const holderRow = (overrides = {}) => ({
        record: '507f1f77bcf86cd799439011',
        registrationId: 'ET-0001',
        name: 'Hana',
        amount: 500,
        included: true,
        note: null,
        accountHolder: '507f1f77bcf86cd799439012',
        accountHolderName: 'Almaz Tesfaye',
        bankAccount: { bankName: 'CBE', accountNumber: '1000123456789' },
        blocked: null,
        bankDetailsChanged: false,
        ...overrides,
    });

    const take = (month, bank, user = finance) =>
        gql.run(schema, exportFile, { user, variables: { record: { month, bankName: bank } } });

    it('returns the four columns with the right content', async () => {
        await approvedMonth([holderRow()]);

        const data = await take('2026-08', 'CBE');
        const lines = data.exportBankFile.contents.trim().split('\n');

        expect(lines[0]).toBe('Account Holder Name,Account Number,Note,Amount');
        expect(lines[1]).toBe('Almaz Tesfaye,1000123456789,,500');
        expect(data.exportBankFile.lineCount).toBe(1);
    });

    it('sums an account holder paid for two beneficiaries onto one line', async () => {
        await approvedMonth([
            holderRow({ amount: 500 }),
            holderRow({ registrationId: 'ET-0002', amount: 300 }),
        ]);

        const data = await take('2026-08', 'CBE');
        expect(data.exportBankFile.contents.trim().split('\n')).toHaveLength(2);
        expect(data.exportBankFile.contents.trim().split('\n')[1]).toMatch(/,800$/);
    });

    it('leaves out unticked rows', async () => {
        await approvedMonth([
            holderRow({ amount: 500 }),
            holderRow({ registrationId: 'ET-0002', amount: 99999, included: false }),
        ]);

        const data = await take('2026-08', 'CBE');
        expect(data.exportBankFile.contents).not.toContain('99999');
    });

    it('serves each bank separately', async () => {
        await approvedMonth([
            holderRow({ amount: 500 }),
            holderRow({
                accountHolder: '507f1f77bcf86cd799439013',
                accountHolderName: 'Bekele',
                bankAccount: { bankName: 'Awash', accountNumber: '2000' },
            }),
        ]);

        const cbe = await take('2026-08', 'CBE');
        const awash = await take('2026-08', 'Awash');

        expect(cbe.exportBankFile.contents).toContain('Almaz Tesfaye');
        expect(cbe.exportBankFile.contents).not.toContain('Bekele');
        expect(awash.exportBankFile.contents).toContain('Bekele');
        expect(awash.exportBankFile.filename).toBe('2026-08-Awash.csv');
    });

    it('refuses a bank this month has nothing to pay at', async () => {
        await approvedMonth([holderRow()]);
        await expect(take('2026-08', 'Dashen')).rejects.toThrow(/nothing to pay at Dashen/);
    });

    it('refuses a draft month', async () => {
        await PaymentPeriod.create({
            month: '2026-08', label: 'August 2026', status: STATUS.DRAFT, rows: [holderRow()],
        });

        await expect(take('2026-08', 'CBE')).rejects.toThrow(/must be approved/);
    });

    it('can be taken again after a reopen and a fresh approval', async () => {
        await approvedMonth([holderRow()]);
        await take('2026-08', 'CBE');

        await gql.run(schema, 'mutation r($record: ReopenPaymentPeriodInput!) { reopenPaymentPeriod(record: $record) { status } }',
            { user: financeAdmin, variables: { record: { month: '2026-08', reason: 'correction' } } });
        await gql.run(schema, 'mutation a($month: String!) { approvePaymentPeriod(month: $month) { status } }',
            { user: financeAdmin, variables: { month: '2026-08' } });

        const data = await take('2026-08', 'CBE');
        expect(data.exportBankFile.contents).toContain('Almaz Tesfaye');
    });

    describe('the audit trail', () => {
        it('records who exported, when and for which bank', async () => {
            await approvedMonth([holderRow()]);
            await take('2026-08', 'CBE');

            const period = await PaymentPeriod.findOne({ month: '2026-08' });
            expect(period.exports).toHaveLength(1);
            expect(period.exports[0].bankName).toBe('CBE');
            expect(period.exports[0].exportedBy.toString()).toBe(finance._id.toString());
            expect(period.exports[0].exportedAt).toBeInstanceOf(Date);
            expect(period.exports[0].superseded).toBe(false);
        });

        it('keeps a repeated export and marks the earlier one superseded after a reopen', async () => {
            await approvedMonth([holderRow()]);
            await take('2026-08', 'CBE');
            await take('2026-08', 'CBE');

            let period = await PaymentPeriod.findOne({ month: '2026-08' });
            expect(period.exports).toHaveLength(2);

            await gql.run(schema, 'mutation r($record: ReopenPaymentPeriodInput!) { reopenPaymentPeriod(record: $record) { status } }',
                { user: financeAdmin, variables: { record: { month: '2026-08', reason: 'correction' } } });

            period = await PaymentPeriod.findOne({ month: '2026-08' });
            expect(period.exports).toHaveLength(2);
            expect(period.exports.every(e => e.superseded)).toBe(true);
        });
    });

    describe('the finance boundary', () => {
        it('refuses every role outside it', async () => {
            await approvedMonth([holderRow()]);

            for (const role of NON_FINANCE_ROLES) {
                const user = await createUser({ roles: [role] });
                await expect(take('2026-08', 'CBE', user)).rejects.toThrow(/Forbidden/);
            }

            const period = await PaymentPeriod.findOne({ month: '2026-08' });
            expect(period.exports).toHaveLength(0);
        });
    });
});