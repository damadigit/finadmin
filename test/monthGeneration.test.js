const {
    monthLabel, isEligible, buildRows, annotateDrift, aggregateRows, rowTotal, BLOCKED,
} = require('../server/payments/monthGeneration');

// No database here on purpose. These are the rules that decide who gets paid and
// how much reaches the bank, so they are tested directly rather than through a
// resolver.

const record = (overrides = {}) => ({
    _id: overrides._id || 'r1',
    registrationId: overrides.registrationId || 'ET-0001',
    name: overrides.name || 'Hana',
    fatherName: overrides.fatherName || 'Mother',
    status: overrides.status === undefined ? 'Active' : overrides.status,
    monthlyAllowance: overrides.monthlyAllowance,
});

const holder = (overrides = {}) => ({
    _id: overrides._id || 'h1',
    name: overrides.name || 'Almaz',
    banks: overrides.banks,
});

describe('month generation', () => {
    describe('monthLabel', () => {
        it('reads the way people write it', () => {
            expect(monthLabel('2026-08')).toBe('August 2026');
            expect(monthLabel('2026-01')).toBe('January 2026');
            expect(monthLabel('2026-12')).toBe('December 2026');
        });

        it('refuses anything that is not a year and month', () => {
            ['2026-13', '2026-00', '26-08', '2026-8', '', null, 'nonsense'].forEach(bad => {
                expect(monthLabel(bad)).toBeNull();
            });
        });
    });

    describe('who belongs in a month', () => {
        it('includes an active beneficiary with an allowance', () => {
            expect(isEligible(record({ monthlyAllowance: 500 }))).toBe(true);
        });

        it('excludes a beneficiary with no allowance, and that is not an error', () => {
            expect(isEligible(record({ monthlyAllowance: undefined }))).toBe(false);
            expect(isEligible(record({ monthlyAllowance: 0 }))).toBe(false);
        });

        it('excludes a discontinued beneficiary', () => {
            expect(isEligible(record({ monthlyAllowance: 500, status: 'Discontinued' }))).toBe(false);
        });
    });

    describe('generated rows', () => {
        const holders = {
            r1: holder({ banks: [{ bankName: 'CBE', accountNumber: '1000' }] }),
        };

        it('starts every eligible row ticked, with no bank details chosen by hand', () => {
            const [row] = buildRows([record({ monthlyAllowance: 500 })], holders);

            expect(row).toMatchObject({
                registrationId: 'ET-0001',
                amount: 500,
                extraAmount: 0,
                included: true,
                blocked: null,
                accountHolderName: 'Almaz',
                bankAccount: { bankName: 'CBE', accountNumber: '1000' },
            });
        });

        it('leaves out beneficiaries with no allowance and discontinued ones', () => {
            const rows = buildRows([
                record({ _id: 'a', monthlyAllowance: 500 }),
                record({ _id: 'b', monthlyAllowance: 0 }),
                record({ _id: 'c', monthlyAllowance: 700, status: 'Discontinued' }),
                record({ _id: 'd', monthlyAllowance: undefined }),
            ], holders);

            expect(rows.map(r => r.record)).toEqual(['a']);
        });

        it('snapshots the allowance rather than reading it live', () => {
            const source = record({ monthlyAllowance: 500 });
            const [row] = buildRows([source], holders);

            source.monthlyAllowance = 999;

            expect(row.amount).toBe(500);
        });

        it('flags a beneficiary with no account holder and does not tick it', () => {
            const [row] = buildRows([record({ monthlyAllowance: 500 })], {});

            expect(row.included).toBe(false);
            expect(row.blocked).toBe(BLOCKED.UNLINKED);
            expect(row.bankAccount).toBeNull();
        });

        it('flags an account holder with no bank account', () => {
            const [row] = buildRows([record({ monthlyAllowance: 500 })], { r1: holder({ banks: [] }) });

            expect(row.included).toBe(false);
            expect(row.blocked).toBe(BLOCKED.NO_BANK_ACCOUNT);
        });

        it('leaves the choice to finance when a holder has several accounts', () => {
            const [row] = buildRows([record({ monthlyAllowance: 500 })], {
                r1: holder({ banks: [{ bankName: 'CBE', accountNumber: '1' }, { bankName: 'Awash', accountNumber: '2' }] }),
            });

            expect(row.included).toBe(false);
            expect(row.blocked).toBe(BLOCKED.CHOOSE_BANK_ACCOUNT);
            expect(row.bankAccount).toBeNull();
        });

        it('never produces a ticked row with no account number', () => {
            const rows = buildRows([
                record({ _id: 'a', monthlyAllowance: 500 }),
                record({ _id: 'b', monthlyAllowance: 500 }),
                record({ _id: 'c', monthlyAllowance: 500 }),
            ], {
                a: null,
                b: holder({ _id: 'hb', banks: [] }),
                c: holder({ _id: 'hc', banks: [{ bankName: 'CBE', accountNumber: '9' }] }),
            });

            rows.filter(r => r.included).forEach(row => {
                expect(row.bankAccount).toBeTruthy();
                expect(row.bankAccount.accountNumber).toBeTruthy();
            });
        });
    });

    describe('bank detail drift', () => {
        const holderWith = banks => ({ r1: holder({ banks }) });

        it('is clean immediately after generation', () => {
            const rows = buildRows([record({ monthlyAllowance: 500 })], {
                r1: holder({ banks: [{ bankName: 'CBE', accountNumber: '1000' }] }),
            });
            expect(annotateDrift(rows, holderWith([{ bankName: 'CBE', accountNumber: '1000' }]))[0].bankDetailsChanged).toBe(false);
        });

        it('is flagged once the account number is corrected', () => {
            const rows = buildRows([record({ monthlyAllowance: 500 })], {
                r1: holder({ banks: [{ bankName: 'CBE', accountNumber: '1000' }] }),
            });
            const corrected = annotateDrift(rows, holderWith([{ bankName: 'CBE', accountNumber: '2000' }]));

            expect(corrected[0].bankDetailsChanged).toBe(true);
            expect(corrected[0].bankAccount.accountNumber).toBe('1000');
        });

        it('is flagged when the holder is deleted outright', () => {
            const rows = buildRows([record({ monthlyAllowance: 500 })], {
                r1: holder({ banks: [{ bankName: 'CBE', accountNumber: '1000' }] }),
            });
            expect(annotateDrift(rows, {})[0].bankDetailsChanged).toBe(true);
        });

        it('does not flag a row that never had an account', () => {
            const rows = buildRows([record({ monthlyAllowance: 500 })], {});
            expect(annotateDrift(rows, {})[0].bankDetailsChanged).toBe(false);
        });
    });

    describe('aggregation into bank lines', () => {
        const row = (overrides = {}) => ({
            record: 'r',
            accountHolder: 'h1',
            accountHolderName: 'Almaz',
            bankAccount: { bankName: 'CBE', accountNumber: '1000' },
            amount: 500,
            included: true,
            note: null,
            ...overrides,
        });

        it('sums one holder paid for several beneficiaries', () => {
            const lines = aggregateRows([
                row({ record: 'r1', amount: 500 }),
                row({ record: 'r2', amount: 300 }),
            ]);

            expect(lines).toHaveLength(1);
            expect(lines[0].amount).toBe(800);
        });

        it('adds a one-off extra on top of the amount', () => {
            expect(rowTotal({ amount: 500, extraAmount: 250 })).toBe(750);
            expect(rowTotal({ amount: 500 })).toBe(500);
        });

        it('pays the amount plus the extra through the bank line', () => {
            const lines = aggregateRows([
                row({ record: 'r1', amount: 500, extraAmount: 250 }),
                row({ record: 'r2', amount: 300 }),
            ]);

            expect(lines[0].amount).toBe(1050);
        });

        it('keeps different account holders apart', () => {
            const lines = aggregateRows([
                row({ record: 'r1', accountHolder: 'h1' }),
                row({ record: 'r2', accountHolder: 'h2', accountHolderName: 'Bekele' }),
            ]);

            expect(lines).toHaveLength(2);
            expect(lines.map(l => l.amount)).toEqual([500, 500]);
        });

        it('keeps different banks apart', () => {
            const lines = aggregateRows([
                row({ record: 'r1', accountHolder: 'h1', bankAccount: { bankName: 'CBE', accountNumber: '1' } }),
                row({ record: 'r2', accountHolder: 'h1', bankAccount: { bankName: 'Awash', accountNumber: '2' } }),
            ]);

            expect(lines.map(l => l.bankName).sort()).toEqual(['Awash', 'CBE']);
        });

        it('never includes an unticked row', () => {
            const lines = aggregateRows([row(), row({ record: 'r2', included: false, amount: 9999 })]);
            expect(lines).toHaveLength(1);
            expect(lines[0].amount).toBe(500);
        });

        it('never includes a row with no account number', () => {
            const lines = aggregateRows([row(), row({ record: 'r2', bankAccount: null })]);
            expect(lines).toHaveLength(1);
        });

        it('joins notes rather than dropping any', () => {
            const lines = aggregateRows([
                row({ record: 'r1', note: 'backdated' }),
                row({ record: 'r2', note: 'school fees' }),
                row({ record: 'r3', note: null }),
            ]);

            expect(lines[0].note).toBe('backdated; school fees');
        });

        it('leaves the note empty when nobody wrote one', () => {
            expect(aggregateRows([row()])[0].note).toBe('');
        });

        it('produces nothing for a month where everything was unticked', () => {
            expect(aggregateRows([row({ included: false })])).toEqual([]);
        });
    });
});