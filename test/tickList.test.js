const db = require('./helpers/db');
const gql = require('./helpers/graphql');
const { createUser, createRecord } = require('./helpers/factories');
const { BLOCKED } = require('../server/payments/monthGeneration');

const NON_FINANCE_ROLES = ['admin', 'handler', 'sponsor', 'etAdmin', 'beAdmin'];

describe('working the tick list', () => {
    let schema;
    let finance;
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
    });

    const setAllowance = `
        mutation setMonthlyAllowance($record: SetMonthlyAllowanceInput!) {
            setMonthlyAllowance(record: $record) { monthlyAllowance }
        }`;

    const setRow = `
        mutation setPayoutRow($record: SetPayoutRowInput!) {
            setPayoutRow(record: $record) { month updated }
        }`;

    const editRow = `
        mutation setPayoutRow($record: SetPayoutRowInput!) {
            setPayoutRow(record: $record) { month updated }
        }`;

    const readMonth = `
        query month($month: String!) {
            paymentMonth(month: $month) {
                status
                rows { record registrationId amount included note blocked bankName accountNumber }
            }
        }`;

    const allow = (record, amount) => gql.run(schema, setAllowance, {
        user: finance, variables: { record: { id: String(record._id), amount } },
    });

    const edit = (record, changes, month = '2026-08') =>
        gql.run(schema, setRow, {
            user: finance, variables: { record: { month, record: String(record._id), ...changes } },
        });

    const rows = async (month = '2026-08') =>
        (await gql.run(schema, readMonth, { user: finance, variables: { month } })).paymentMonth.rows;

    const setup = async ({ banks = [{ bankName: 'CBE', accountNumber: '1000' }], amount = 500, status = 'Active' } = {}) => {
        const holder = banks ? await AccountHolder.create({ name: 'Almaz', banks }) : null;
        const record = await createRecord({ registrationId: 'ET-0001', status });
        record.accountHolder = holder ? holder._id : undefined;
        await record.save();
        await allow(record, amount);
        await gql.run(schema, 'mutation g($record: GeneratePaymentPeriodInput!) { generatePaymentPeriod(record: $record) { id } }',
            { user: finance, variables: { record: { month: '2026-08' } } });
        return { holder, record };
    };

    describe('unticking', () => {
        it('unticks a row and keeps the note that explains it', async () => {
            const { record } = await setup();

            await edit(record, { included: false, note: 'family left the area' });

            const [row] = await rows();
            expect(row.included).toBe(false);
            expect(row.note).toBe('family left the area');
        });

        it('re-ticks a row that was unticked', async () => {
            const { record } = await setup();
            await edit(record, { included: false });

            await edit(record, { included: true });

            expect((await rows())[0].included).toBe(true);
        });

        it('leaves the rest of the tick list alone', async () => {
            const { holder } = await setup();
            const other = await createRecord({ registrationId: 'ET-0002' });
            other.accountHolder = holder._id;
            await other.save();
            await allow(other, 300);
            await edit((await Record.findOne({ registrationId: 'ET-0001' })), {}); // no-op
            await gql.run(schema, 'mutation d($record: GeneratePaymentPeriodInput!) { generatePaymentPeriod(record: $record) { id } }',
                { user: finance, variables: { record: { month: '2026-09' } } });

            await edit(other, { included: false }, '2026-09');

            const before = await rows('2026-08');
            expect(before).toHaveLength(1);
            expect(before[0].included).toBe(true);
        });
    });

    describe('adjusting an amount for one month', () => {
        it('changes the month without touching the standing allowance', async () => {
            const { record } = await setup({ amount: 500 });

            await edit(record, { amount: 750 });

            expect((await rows())[0].amount).toBe(750);
            expect((await Record.findById(record._id)).monthlyAllowance).toBe(500);
        });

        it('leaves a later month on the new standing figure', async () => {
            const { record } = await setup({ amount: 500 });
            await edit(record, { amount: 750 });
            await allow(record, 900);
            await gql.run(schema, 'mutation g($record: GeneratePaymentPeriodInput!) { generatePaymentPeriod(record: $record) { id } }',
                { user: finance, variables: { record: { month: '2026-09' } } });

            expect((await rows('2026-08'))[0].amount).toBe(750);
            expect((await rows('2026-09'))[0].amount).toBe(900);
        });

        it('refuses a fractional amount', async () => {
            const { record } = await setup();
            await expect(edit(record, { amount: 750.5 })).rejects.toThrow();
        });

        it('refuses a negative amount', async () => {
            const { record } = await setup();
            await expect(edit(record, { amount: -1 })).rejects.toThrow(/whole number/);
        });
    });

    describe('rows that cannot be ticked', () => {
        it('refuses to tick a beneficiary with no account holder', async () => {
            const { record } = await setup({ banks: null });

            await expect(edit(record, { included: true })).rejects.toThrow(/cannot be ticked/);
            expect((await rows())[0].blocked).toBe(BLOCKED.UNLINKED);
        });

        it('refuses to tick a holder with no bank account', async () => {
            const { record } = await setup({ banks: [] });

            await expect(edit(record, { included: true })).rejects.toThrow(/cannot be ticked/);
            expect((await rows())[0].blocked).toBe(BLOCKED.NO_BANK_ACCOUNT);
        });

        it('lets finance tick an unticked row without unblocking it', async () => {
            const { record } = await setup({ banks: null });

            await edit(record, { included: false });

            expect((await rows())[0].included).toBe(false);
        });

        it('refuses a note-only edit to an untickable row but still records it', async () => {
            const { record } = await setup({ banks: null });

            await edit(record, { note: 'waiting on bank details' });

            const [row] = await rows();
            expect(row.note).toBe('waiting on bank details');
            expect(row.included).toBe(false);
        });
    });

    describe('choosing which account pays', () => {
        it('clears the block and ticks once finance chooses', async () => {
            const { record } = await setup({
                banks: [{ bankName: 'CBE', accountNumber: '1' }, { bankName: 'Awash', accountNumber: '2' }],
            });

            expect((await rows())[0].blocked).toBe(BLOCKED.CHOOSE_BANK_ACCOUNT);

            await edit(record, {
                bankAccount: { bankName: 'Awash', accountNumber: '2' },
                included: true,
            });

            const [row] = await rows();
            expect(row.blocked).toBeNull();
            expect(row.included).toBe(true);
            expect(row.bankName).toBe('Awash');
            expect(row.accountNumber).toBe('2');
        });

        it('refuses an account the holder does not have', async () => {
            const { record } = await setup({
                banks: [{ bankName: 'CBE', accountNumber: '1' }, { bankName: 'Awash', accountNumber: '2' }],
            });

            await expect(
                edit(record, { bankAccount: { bankName: 'Dashen', accountNumber: '99' } })
            ).rejects.toThrow(/not one of this account holder/);
        });
    });

    describe('a month that is no longer a draft', () => {
        it('refuses every edit once approved', async () => {
            const { record } = await setup();
            const period = await PaymentPeriod.findOne({ month: '2026-08' });
            period.status = 'Approved';
            await period.save();

            await expect(edit(record, { included: false })).rejects.toThrow(/can no longer be changed/);
            await expect(edit(record, { amount: 1 })).rejects.toThrow(/can no longer be changed/);
            await expect(edit(record, { note: 'x' })).rejects.toThrow(/can no longer be changed/);
        });
    });

    describe('the finance boundary', () => {
        it('refuses every edit to roles outside it', async () => {
            const { record } = await setup();

            for (const role of NON_FINANCE_ROLES) {
                const user = await createUser({ roles: [role] });
                await expect(
                    gql.run(schema, editRow, {
                        user,
                        variables: { record: { month: '2026-08', record: String(record._id), included: false } },
                    })
                ).rejects.toThrow(/Forbidden/);
            }
            expect((await rows())[0].included).toBe(true);
        });
    });
});