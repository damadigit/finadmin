const db = require('./helpers/db');
const gql = require('./helpers/graphql');
const { createUser, createRecord } = require('./helpers/factories');
const { STATUS } = require('../server/payments/monthLifecycle');

const NON_FINANCE_ROLES = ['admin', 'handler', 'sponsor', 'etAdmin', 'beAdmin'];

describe('the month lifecycle', () => {
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

    const approve = 'mutation approve($month: String!) { approvePaymentPeriod(month: $month) { month status } }';
    const markPaid = 'mutation pay($month: String!) { markPaymentPeriodPaid(month: $month) { month status } }';
    const reopen = `mutation reopen($record: ReopenPaymentPeriodInput!) {
        reopenPaymentPeriod(record: $record) { month status supersededExports }
    }`;
    const editRow = `mutation setPayoutRow($record: SetPayoutRowInput!) { setPayoutRow(record: $record) { updated } }`;
    const generate = 'mutation g($record: GeneratePaymentPeriodInput!) { generatePaymentPeriod(record: $record) { id } }';

    // A month with one payable beneficiary unless told otherwise.
    const setup = async ({ banks = [{ bankName: 'CBE', accountNumber: '1000' }] } = {}) => {
        const holder = banks ? await AccountHolder.create({ name: 'Almaz', banks }) : null;
        const record = await createRecord({ registrationId: 'ET-0001' });
        record.accountHolder = holder ? holder._id : undefined;
        await record.save();
        await gql.run(schema, 'mutation a($record: SetMonthlyAllowanceInput!) { setMonthlyAllowance(record: $record) { monthlyAllowance } }',
            { user: finance, variables: { record: { id: String(record._id), amount: 500 } } });
        await gql.run(schema, generate, { user: finance, variables: { record: { month: '2026-08' } } });
        return { holder, record };
    };

    describe('approving', () => {
        it('records who approved and when', async () => {
            await setup();

            const data = await gql.run(schema, approve, { user: financeAdmin, variables: { month: '2026-08' } });
            expect(data.approvePaymentPeriod.status).toBe(STATUS.APPROVED);

            const period = await PaymentPeriod.findOne({ month: '2026-08' });
            expect(period.approvedBy.toString()).toBe(financeAdmin._id.toString());
            expect(period.approvedAt).toBeInstanceOf(Date);
        });

        it('is refused while any row still needs resolving', async () => {
            const { record } = await setup({ banks: null });

            await expect(
                gql.run(schema, approve, { user: financeAdmin, variables: { month: '2026-08' } })
            ).rejects.toThrow(/still need resolving/);
        });

        it('names the stuck rows so they can be found', async () => {
            await setup({ banks: null });

            await expect(
                gql.run(schema, approve, { user: financeAdmin, variables: { month: '2026-08' } })
            ).rejects.toThrow(/ET-0001/);
        });

        it('is refused when nobody is ticked', async () => {
            const { record } = await setup();
            await gql.run(schema, editRow, {
                user: finance, variables: { record: { month: '2026-08', record: String(record._id), included: false } },
            });

            await expect(
                gql.run(schema, approve, { user: financeAdmin, variables: { month: '2026-08' } })
            ).rejects.toThrow(/no beneficiaries are ticked/);
        });

        it('is refused twice', async () => {
            await setup();
            await gql.run(schema, approve, { user: financeAdmin, variables: { month: '2026-08' } });

            await expect(
                gql.run(schema, approve, { user: financeAdmin, variables: { month: '2026-08' } })
            ).rejects.toThrow(/already approved/);
        });

        it('is refused to a plain finance officer', async () => {
            await setup();

            await expect(
                gql.run(schema, approve, { user: finance, variables: { month: '2026-08' } })
            ).rejects.toThrow(/finance administrators/);

            expect((await PaymentPeriod.findOne({ month: '2026-08' })).status).toBe(STATUS.DRAFT);
        });

        it('is refused to every role outside the finance boundary', async () => {
            await setup();

            for (const role of NON_FINANCE_ROLES) {
                const user = await createUser({ roles: [role] });
                await expect(
                    gql.run(schema, approve, { user, variables: { month: '2026-08' } })
                ).rejects.toThrow(/Forbidden/);
            }
        });
    });

    describe('the freeze', () => {
        it('refuses every kind of edit once approved', async () => {
            const { record } = await setup();
            await gql.run(schema, approve, { user: financeAdmin, variables: { month: '2026-08' } });

            for (const changes of [
                { included: false }, { amount: 1 }, { note: 'x' },
                { bankAccount: { bankName: 'Awash', accountNumber: '9' } },
            ]) {
                await expect(
                    gql.run(schema, editRow, {
                        user: finance,
                        variables: { record: { month: '2026-08', record: String(record._id), ...changes } },
                    })
                ).rejects.toThrow(/can no longer be changed/);
            }
        });

        it('keeps the rows exactly as they were approved', async () => {
            const { record } = await setup();
            await gql.run(schema, editRow, {
                user: finance, variables: { record: { month: '2026-08', record: String(record._id), amount: 700, note: 'agreed' } },
            });
            await gql.run(schema, approve, { user: financeAdmin, variables: { month: '2026-08' } });

            const period = await PaymentPeriod.findOne({ month: '2026-08' });
            expect(period.rows[0].amount).toBe(700);
            expect(period.rows[0].note).toBe('agreed');
        });

        it('refuses to regenerate a month that already exists, approved or not', async () => {
            await setup();
            await gql.run(schema, approve, { user: financeAdmin, variables: { month: '2026-08' } });

            await expect(
                gql.run(schema, generate, { user: finance, variables: { record: { month: '2026-08' } } })
            ).rejects.toThrow(/already been generated/);
        });
    });

    describe('marking paid', () => {
        it('cannot jump straight from draft to paid', async () => {
            await setup();

            await expect(
                gql.run(schema, markPaid, { user: financeAdmin, variables: { month: '2026-08' } })
            ).rejects.toThrow(/only be marked paid once it has been approved/);
        });

        it('records who settled it and when', async () => {
            await setup();
            await gql.run(schema, approve, { user: financeAdmin, variables: { month: '2026-08' } });

            await gql.run(schema, markPaid, { user: financeAdmin, variables: { month: '2026-08' } });

            const period = await PaymentPeriod.findOne({ month: '2026-08' });
            expect(period.status).toBe(STATUS.PAID);
            expect(period.paidBy.toString()).toBe(financeAdmin._id.toString());
            expect(period.paidAt).toBeInstanceOf(Date);
        });

        it('is refused to a plain finance officer', async () => {
            await setup();
            await gql.run(schema, approve, { user: financeAdmin, variables: { month: '2026-08' } });

            await expect(
                gql.run(schema, markPaid, { user: finance, variables: { month: '2026-08' } })
            ).rejects.toThrow(/finance administrators/);
        });
    });

    describe('reopening', () => {
        it('returns an approved month to draft so it can be corrected', async () => {
            await setup();
            await gql.run(schema, approve, { user: financeAdmin, variables: { month: '2026-08' } });

            const data = await gql.run(schema, reopen, {
                user: financeAdmin, variables: { record: { month: '2026-08', reason: 'wrong amount' } },
            });
            expect(data.reopenPaymentPeriod.status).toBe(STATUS.DRAFT);

            const period = await PaymentPeriod.findOne({ month: '2026-08' });
            expect(period.status).toBe(STATUS.DRAFT);
            expect(period.reopenedBy.toString()).toBe(financeAdmin._id.toString());
            expect(period.reopenReason).toBe('wrong amount');
            expect(period.approvedAt).toBeUndefined();
        });

        it('works from paid as well', async () => {
            await setup();
            await gql.run(schema, approve, { user: financeAdmin, variables: { month: '2026-08' } });
            await gql.run(schema, markPaid, { user: financeAdmin, variables: { month: '2026-08' } });

            await gql.run(schema, reopen, {
                user: financeAdmin, variables: { record: { month: '2026-08', reason: 'one family short paid' } },
            });

            expect((await PaymentPeriod.findOne({ month: '2026-08' })).status).toBe(STATUS.DRAFT);
        });

        it('requires a reason', async () => {
            await setup();
            await gql.run(schema, approve, { user: financeAdmin, variables: { month: '2026-08' } });

            await expect(
                gql.run(schema, reopen, { user: financeAdmin, variables: { record: { month: '2026-08', reason: '  ' } } })
            ).rejects.toThrow(/requires a reason/);
        });

        it('is not offered for a month that is already a draft', async () => {
            await setup();
            await expect(
                gql.run(schema, reopen, { user: financeAdmin, variables: { record: { month: '2026-08', reason: 'x' } } })
            ).rejects.toThrow(/does not need reopening/);
        });

        it('marks earlier bank files superseded rather than deleting them', async () => {
            await setup();
            await gql.run(schema, approve, { user: financeAdmin, variables: { month: '2026-08' } });

            const period = await PaymentPeriod.findOne({ month: '2026-08' });
            period.exports.push({ bankName: 'CBE', exportedBy: financeAdmin._id, exportedAt: new Date() });
            await period.save();

            const data = await gql.run(schema, reopen, {
                user: financeAdmin, variables: { record: { month: '2026-08', reason: 'correction' } },
            });
            expect(data.reopenPaymentPeriod.supersededExports).toBe(1);

            const after = await PaymentPeriod.findOne({ month: '2026-08' });
            expect(after.exports).toHaveLength(1);
            expect(after.exports[0].superseded).toBe(true);
        });

        it('is refused to a plain finance officer and to everyone else', async () => {
            await setup();
            await gql.run(schema, approve, { user: financeAdmin, variables: { month: '2026-08' } });

            await expect(
                gql.run(schema, reopen, { user: finance, variables: { record: { month: '2026-08', reason: 'x' } } })
            ).rejects.toThrow(/finance administrators/);

            for (const role of NON_FINANCE_ROLES) {
                const user = await createUser({ roles: [role] });
                await expect(
                    gql.run(schema, reopen, { user, variables: { record: { month: '2026-08', reason: 'x' } } })
                ).rejects.toThrow(/Forbidden/);
            }
        });

        it('puts the month back to being approvable', async () => {
            await setup();
            await gql.run(schema, approve, { user: financeAdmin, variables: { month: '2026-08' } });
            await gql.run(schema, reopen, {
                user: financeAdmin, variables: { record: { month: '2026-08', reason: 'correction' } },
            });

            const data = await gql.run(schema, approve, { user: financeAdmin, variables: { month: '2026-08' } });
            expect(data.approvePaymentPeriod.status).toBe(STATUS.APPROVED);
        });
    });
});