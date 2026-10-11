const db = require('./helpers/db');
const gql = require('./helpers/graphql');
const { createUser, createRecord } = require('./helpers/factories');
const { BLOCKED } = require('../server/payments/monthGeneration');

const NON_FINANCE_ROLES = ['admin', 'handler', 'sponsor', 'etAdmin', 'beAdmin'];

describe('generating a payment month', () => {
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

    const generate = `
        mutation generatePaymentPeriod($record: GeneratePaymentPeriodInput!) {
            generatePaymentPeriod(record: $record) {
                id month label status rowCount untickableCount
            }
        }`;

    const readMonth = `
        query month($month: String!) {
            paymentMonth(month: $month) {
                id label status
                rows {
                    record registrationId name amount included note
                    accountHolderName bankName accountNumber blocked bankDetailsChanged
                }
            }
        }`;

    const allow = (record, amount) =>
        gql.run(schema, setAllowance, {
            user: finance,
            variables: { record: { id: String(record._id), amount } },
        });

    const holder = (name, banks) => AccountHolder.create({ name, banks });

    const linkedRecord = async (registrationId, amount, accountHolder) => {
        const record = await createRecord({ registrationId });
        record.accountHolder = accountHolder ? accountHolder._id : undefined;
        await record.save();
        await allow(record, amount);
        return record;
    };

    describe('the generated month', () => {
        it('fills with every active beneficiary holding an allowance, all ticked', async () => {
            const shared = await holder('Almaz', [{ bankName: 'CBE', accountNumber: '1000' }]);
            await linkedRecord('ET-0001', 500, shared);
            await linkedRecord('ET-0002', 300, shared);

            const data = await gql.run(schema, generate, {
                user: finance, variables: { record: { month: '2026-08' } },
            });

            expect(data.generatePaymentPeriod).toMatchObject({
                month: '2026-08', label: 'August 2026', status: 'Draft', rowCount: 2, untickableCount: 0,
            });

            const month = await gql.run(schema, readMonth, {
                user: finance, variables: { month: '2026-08' },
            });

            expect(month.paymentMonth.rows).toHaveLength(2);
            month.paymentMonth.rows.forEach(row => {
                expect(row.included).toBe(true);
                expect(row.bankName).toBe('CBE');
                expect(row.blocked).toBeNull();
            });
        });

        it('leaves out a beneficiary with no allowance, without complaining', async () => {
            const shared = await holder('Almaz', [{ bankName: 'CBE', accountNumber: '1000' }]);
            await linkedRecord('ET-0001', 500, shared);
            await createRecord({ registrationId: 'ET-0002' });

            const data = await gql.run(schema, generate, {
                user: finance, variables: { record: { month: '2026-08' } },
            });

            expect(data.generatePaymentPeriod.rowCount).toBe(1);
            expect(data.generatePaymentPeriod.untickableCount).toBe(0);
        });

        it('leaves out a discontinued beneficiary', async () => {
            const shared = await holder('Almaz', [{ bankName: 'CBE', accountNumber: '1000' }]);
            await linkedRecord('ET-0001', 500, shared);
            await linkedRecord('ET-0002', 700, shared);
            await Record.updateOne({ registrationId: 'ET-0002' }, { status: 'Discontinued' });

            const data = await gql.run(schema, generate, {
                user: finance, variables: { record: { month: '2026-08' } },
            });

            expect(data.generatePaymentPeriod.rowCount).toBe(1);
        });

        it('snapshots the allowance and never writes back to it', async () => {
            const shared = await holder('Almaz', [{ bankName: 'CBE', accountNumber: '1000' }]);
            const record = await linkedRecord('ET-0001', 500, shared);

            await gql.run(schema, generate, { user: finance, variables: { record: { month: '2026-08' } } });

            const month = await gql.run(schema, readMonth, {
                user: finance, variables: { month: '2026-08' },
            });
            expect(month.paymentMonth.rows[0].amount).toBe(500);

            await allow(record, 900);

            const reread = await gql.run(schema, readMonth, {
                user: finance, variables: { month: '2026-08' },
            });
            expect(reread.paymentMonth.rows[0].amount).toBe(500);
            expect((await Record.findById(record._id)).monthlyAllowance).toBe(900);
        });

        it('refuses to generate the same month twice', async () => {
            await gql.run(schema, generate, { user: finance, variables: { record: { month: '2026-08' } } });

            await expect(
                gql.run(schema, generate, { user: finance, variables: { record: { month: '2026-08' } } })
            ).rejects.toThrow(/already been generated/);
        });

        it('refuses a month that is not a month', async () => {
            for (const bad of ['2026-13', 'August', '2026-8', '']) {
                await expect(
                    gql.run(schema, generate, { user: finance, variables: { record: { month: bad } } })
                ).rejects.toThrow(/not a month/);
            }
        });
    });

    describe('rows that cannot be paid', () => {
        const rowsFor = async () => {
            const data = await gql.run(schema, readMonth, {
                user: finance, variables: { month: '2026-08' },
            });
            return data.paymentMonth.rows;
        };

        it('flags a beneficiary with no account holder', async () => {
            await linkedRecord('ET-0001', 500, null);

            const result = await gql.run(schema, generate, {
                user: finance, variables: { record: { month: '2026-08' } },
            });
            expect(result.generatePaymentPeriod.untickableCount).toBe(1);

            const [row] = await rowsFor();
            expect(row).toMatchObject({ included: false, blocked: BLOCKED.UNLINKED, bankName: null });
        });

        it('flags an account holder with no bank account', async () => {
            await linkedRecord('ET-0001', 500, await holder('Almaz', []));

            await gql.run(schema, generate, { user: finance, variables: { record: { month: '2026-08' } } });
            const [row] = await rowsFor();
            expect(row.blocked).toBe(BLOCKED.NO_BANK_ACCOUNT);
        });

        it('leaves the choice to finance when a holder has several accounts', async () => {
            await linkedRecord('ET-0001', 500, await holder('Almaz', [
                { bankName: 'CBE', accountNumber: '1' },
                { bankName: 'Awash', accountNumber: '2' },
            ]));

            await gql.run(schema, generate, { user: finance, variables: { record: { month: '2026-08' } } });
            const [row] = await rowsFor();
            expect(row.blocked).toBe(BLOCKED.CHOOSE_BANK_ACCOUNT);
            expect(row.bankName).toBeNull();
        });
    });

    describe('bank details corrected after generation', () => {
        it('is flagged as drifted, and the generated row keeps what was captured', async () => {
            const shared = await holder('Almaz', [{ bankName: 'CBE', accountNumber: '1000' }]);
            await linkedRecord('ET-0001', 500, shared);

            await gql.run(schema, generate, { user: finance, variables: { record: { month: '2026-08' } } });

            let [row] = (await gql.run(schema, readMonth, { user: finance, variables: { month: '2026-08' } })).paymentMonth.rows;
            expect(row.bankDetailsChanged).toBe(false);

            shared.banks = [{ bankName: 'CBE', accountNumber: '2000' }];
            await shared.save();

            [row] = (await gql.run(schema, readMonth, { user: finance, variables: { month: '2026-08' } })).paymentMonth.rows;
            expect(row.bankDetailsChanged).toBe(true);
            expect(row.accountNumber).toBe('1000');
        });
    });

    describe('the finance boundary', () => {
        it('refuses generation to every role outside it', async () => {
            for (const role of NON_FINANCE_ROLES) {
                const user = await createUser({ roles: [role] });
                await expect(
                    gql.run(schema, generate, { user, variables: { record: { month: '2026-08' } } })
                ).rejects.toThrow(/Forbidden/);
            }
            expect(await PaymentPeriod.countDocuments({})).toBe(0);
        });

        it('refuses reading a month to every role outside it', async () => {
            await gql.run(schema, generate, { user: finance, variables: { record: { month: '2026-08' } } });

            for (const role of NON_FINANCE_ROLES) {
                const user = await createUser({ roles: [role] });
                await expect(
                    gql.run(schema, readMonth, { user, variables: { month: '2026-08' } })
                ).rejects.toThrow(/Forbidden/);
            }
        });
    });
});