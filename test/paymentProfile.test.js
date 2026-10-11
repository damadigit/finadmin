const db = require('./helpers/db');
const gql = require('./helpers/graphql');
const { createUser, createRecord } = require('./helpers/factories');

const NON_FINANCE_ROLES = ['admin', 'handler', 'sponsor', 'etAdmin', 'beAdmin'];

describe('payment profile and standing allowance', () => {
    let schema;
    let finance;
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
        finance = await createUser({ roles: ['finance'] });
    });

    const setAllowance = `
        mutation setMonthlyAllowance($record: SetMonthlyAllowanceInput!) {
            setMonthlyAllowance(record: $record) { id monthlyAllowance }
        }
    `;

    const linkHolder = `
        mutation setBeneficiaryAccountHolder($record: SetAccountHolderInput!) {
            setBeneficiaryAccountHolder(record: $record) { id accountHolderId }
        }
    `;

    const profile = `
        query profile($id: MongoID!) {
            paymentProfile(id: $id) {
                id registrationId name status monthlyAllowance
                accountHolderId
                accountHolder { id name banks { _id bankName accountNumber } }
                allowanceHistory { amount previousAmount note changedBy changedAt }
            }
        }
    `;

    describe('setting the allowance', () => {
        it('sets the standing allowance', async () => {
            const record = await createRecord();

            const data = await gql.run(schema, setAllowance, {
                user: finance,
                variables: { record: { id: record._id.toString(), amount: 600 } },
            });

            expect(data.setMonthlyAllowance.monthlyAllowance).toBe(600);
            expect((await Record.findById(record._id)).monthlyAllowance).toBe(600);
        });

        it('records the previous amount, who changed it and when', async () => {
            const record = await createRecord();
            await gql.run(schema, setAllowance, {
                user: finance, variables: { record: { id: record._id.toString(), amount: 500 } },
            });

            await gql.run(schema, setAllowance, {
                user: finance,
                variables: { record: { id: record._id.toString(), amount: 800, note: 'cost of living' } },
            });

            const saved = await Record.findById(record._id);
            expect(saved.allowanceHistory).toHaveLength(2);

            const [first] = saved.allowanceHistory;
            expect(first.amount).toBe(500);
            // Null rather than absent: "there was no allowance before this" is a
            // fact worth keeping, not a missing value.
            expect(first.previousAmount).toBeNull();
            expect(first.changedBy.toString()).toBe(finance._id.toString());
            expect(first.changedAt).toBeInstanceOf(Date);

            const second = saved.allowanceHistory[1];
            expect(second.amount).toBe(800);
            expect(second.previousAmount).toBe(500);
            expect(second.note).toBe('cost of living');
        });

        it('records a change even when the amount is unchanged', async () => {
            const record = await createRecord();
            const args = { id: record._id.toString(), amount: 500 };

            await gql.run(schema, setAllowance, { user: finance, variables: { record: args } });
            await gql.run(schema, setAllowance, { user: finance, variables: { record: args } });

            expect((await Record.findById(record._id)).allowanceHistory).toHaveLength(2);
        });

        it('rejects a negative allowance', async () => {
            const record = await createRecord();
            await expect(
                gql.run(schema, setAllowance, {
                    user: finance, variables: { record: { id: record._id.toString(), amount: -1 } },
                })
            ).rejects.toThrow(/negative/);
        });

        it('allows the allowance to be cleared', async () => {
            const record = await createRecord();
            await gql.run(schema, setAllowance, {
                user: finance, variables: { record: { id: record._id.toString(), amount: 500 } },
            });

            const data = await gql.run(schema, setAllowance, {
                user: finance, variables: { record: { id: record._id.toString(), amount: null } },
            });

            expect(data.setMonthlyAllowance.monthlyAllowance).toBeNull();
        });

        it('refuses every role outside the finance boundary', async () => {
            const record = await createRecord();
            for (const role of NON_FINANCE_ROLES) {
                const user = await createUser({ roles: [role] });
                await expect(
                    gql.run(schema, setAllowance, {
                        user, variables: { record: { id: record._id.toString(), amount: 9999 } },
                    })
                ).rejects.toThrow(/Forbidden/);
            }
            expect((await Record.findById(record._id)).monthlyAllowance).toBeUndefined();
        });
    });

    describe('the boundary holds', () => {
        it('does not expose the allowance on the ordinary beneficiary type', async () => {
            const record = await createRecord();
            await gql.run(schema, setAllowance, {
                user: finance, variables: { record: { id: record._id.toString(), amount: 600 } },
            });

            await expect(
                gql.run(schema, '{ allRecords { id monthlyAllowance } }', { user: finance })
            ).rejects.toThrow(/monthlyAllowance/);
        });

        it('does not let the allowance be set through the ordinary update', async () => {
            const record = await createRecord();

            await expect(
                gql.run(
                    schema,
                    'mutation updateRecord($record: UpdateByIdRecordInput!) { updateRecord(record: $record) { record { id } } }',
                    { user: await createUser({ roles: ['admin'] }), variables: { record: { _id: record._id.toString(), monthlyAllowance: 9999 } } }
                )
            ).rejects.toThrow(/monthlyAllowance/);

            expect((await Record.findById(record._id)).monthlyAllowance).toBeUndefined();
        });

        it('does not let the account holder be re-pointed through the ordinary update', async () => {
            const record = await createRecord();
            const holder = await AccountHolder.create({ name: 'Someone' });
            await record.updateOne({ accountHolder: holder._id });

            await expect(
                gql.run(
                    schema,
                    'mutation updateRecord($record: UpdateByIdRecordInput!) { updateRecord(record: $record) { record { id } } }',
                    { user: await createUser({ roles: ['admin'] }), variables: { record: { _id: record._id.toString(), accountHolder: holder._id.toString() } } }
                )
            ).rejects.toThrow(/accountHolder/);
        });

        it('refuses the profile to every role outside the finance boundary', async () => {
            const record = await createRecord();
            for (const role of NON_FINANCE_ROLES) {
                const user = await createUser({ roles: [role] });
                await expect(
                    gql.run(schema, profile, { user, variables: { id: record._id.toString() } })
                ).rejects.toThrow(/Forbidden/);
            }
        });
    });

    describe('linking and detaching', () => {
        it('links and detaches through the guarded mutation', async () => {
            const record = await createRecord();
            const holder = await AccountHolder.create({ name: 'Almaz' });

            const linked = await gql.run(schema, linkHolder, {
                user: finance, variables: { record: { id: record._id.toString(), accountHolder: holder._id.toString() } },
            });
            expect(linked.setBeneficiaryAccountHolder.accountHolderId).toBe(holder._id.toString());

            const detached = await gql.run(schema, linkHolder, {
                user: finance, variables: { record: { id: record._id.toString(), accountHolder: null } },
            });
            expect(detached.setBeneficiaryAccountHolder.accountHolderId).toBeNull();
        });

        it('refuses a link to an account holder that does not exist', async () => {
            const record = await createRecord();
            await expect(
                gql.run(schema, linkHolder, {
                    user: finance,
                    variables: { record: { id: record._id.toString(), accountHolder: '507f1f77bcf86cd799439011' } },
                })
            ).rejects.toThrow(/No such account holder/);
        });

        it('refuses linking for every role outside the finance boundary', async () => {
            const record = await createRecord();
            const holder = await AccountHolder.create({ name: 'Almaz' });
            for (const role of NON_FINANCE_ROLES) {
                const user = await createUser({ roles: [role] });
                await expect(
                    gql.run(schema, linkHolder, {
                        user, variables: { record: { id: record._id.toString(), accountHolder: holder._id.toString() } },
                    })
                ).rejects.toThrow(/Forbidden/);
            }
        });
    });

    describe('the profile finance sees', () => {
        it('brings the beneficiary, holder and allowance together', async () => {
            const record = await createRecord({ name: 'Hana', registrationId: 'ET-0042' });
            const holder = await AccountHolder.create({
                name: 'Almaz', banks: [{ bankName: 'CBE', accountNumber: '1000' }],
            });
            record.accountHolder = holder._id;
            await record.save();

            await gql.run(schema, setAllowance, {
                user: finance, variables: { record: { id: record._id.toString(), amount: 750 } },
            });

            const data = await gql.run(schema, profile, { user: finance, variables: { id: record._id.toString() } });
            const p = data.paymentProfile;

            expect(p).toMatchObject({ registrationId: 'ET-0042', name: 'Hana', monthlyAllowance: 750 });
            expect(p.accountHolder).toMatchObject({
                name: 'Almaz',
                banks: [{ bankName: 'CBE', accountNumber: '1000' }],
            });
            expect(p.allowanceHistory[0].amount).toBe(750);
        });

        it('reports no allowance for a beneficiary who has never had one', async () => {
            const record = await createRecord();
            const data = await gql.run(schema, profile, { user: finance, variables: { id: record._id.toString() } });

            expect(data.paymentProfile.monthlyAllowance).toBeNull();
            expect(data.paymentProfile.allowanceHistory).toEqual([]);
            expect(data.paymentProfile.accountHolder).toBeNull();
        });
    });
});