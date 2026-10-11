const { buildBankFile, bankLines, bankNames, COLUMNS } = require('../server/payments/bankFile');
const { annotateDrift } = require('../server/payments/monthGeneration');

// The file is the last point at which finance can catch a mistake, and the
// first point at which a mistake costs real money. These assert the exact bytes.

const row = (overrides = {}) => ({
    record: 'r1',
    registrationId: 'ET-0001',
    accountHolder: 'h1',
    accountHolderName: 'Almaz Tesfaye',
    bankAccount: { bankName: 'CBE', accountNumber: '1000123456789' },
    amount: 500,
    included: true,
    note: null,
    blocked: null,
    ...overrides,
});

describe('the bank file', () => {
    describe('shape', () => {
        it('begins with the four columns, in order, spelled the way the bank does', () => {
            const csv = buildBankFile([]);
            expect(csv.split('\n')[0]).toBe('Account Holder Name,Account Number,Note,Amount');
        });

        it('has no byte-order mark', () => {
            expect(buildBankFile([]).charCodeAt(0)).not.toBe(0xFEFF);
        });

        it('uses LF endings and nothing else', () => {
            const csv = buildBankFile([{
                accountHolderName: 'Almaz', accountNumber: '1', note: null, amount: 500, bankName: 'CBE',
            }]);
            expect(csv).not.toContain('\r');
            expect(csv.endsWith('\n')).toBe(true);
        });

        it('has no total row', () => {
            const csv = buildBankFile([{
                accountHolderName: 'Almaz', accountNumber: '1', note: null, amount: 500, bankName: 'CBE',
            }]);
            const dataRows = csv.trim().split('\n').slice(1);
            expect(dataRows).toHaveLength(1);
            expect(csv).not.toMatch(/total/i);
        });

        it('writes amounts as bare integers a bank will read as a number', () => {
            const csv = buildBankFile([{
                accountHolderName: 'Almaz', accountNumber: '1', note: null, amount: 1500000, bankName: 'CBE',
            }]);
            const amount = csv.trim().split('\n')[1].split(',').pop();

            expect(amount).toBe('1500000');
            expect(Number.isInteger(Number(amount))).toBe(true);
            expect(amount).not.toMatch(/[.,]/);
            expect(amount).not.toMatch(/[A-Za-z]/);
        });

        it('leaves an unused note column empty rather than writing a placeholder', () => {
            const csv = buildBankFile([{
                accountHolderName: 'Almaz', accountNumber: '1', note: '', amount: 500, bankName: 'CBE',
            }]);
            expect(csv.trim().split('\n')[1]).toBe('Almaz,1,,500');
        });
    });

    describe('quoting', () => {
        const line = note => [{ accountHolderName: 'Almaz', accountNumber: '1', note, amount: 500, bankName: 'CBE' }];

        it('quotes a note containing a comma', () => {
            expect(buildBankFile(line('backdated, partial')).trim().split('\n')[1])
                .toBe('Almaz,1,"backdated, partial",500');
        });

        it('quotes and doubles a note containing a quote', () => {
            expect(buildBankFile(line('paid "in full"')).trim().split('\n')[1])
                .toBe('Almaz,1,"paid ""in full""",500');
        });

        it('quotes a note containing a newline', () => {
            const out = buildBankFile(line('first line\nsecond line'));
            expect(out).toContain('"first line\nsecond line"');
        });

        it('leaves an ordinary value unquoted', () => {
            expect(buildBankFile([{
                accountHolderName: 'Almaz', accountNumber: '1000', note: 'school fees', amount: 500, bankName: 'CBE',
            }]).trim().split('\n')[1]).toBe('Almaz,1000,school fees,500');
        });
    });

    describe('what reaches the bank', () => {
        it('sends one line per account holder, summing their beneficiaries', () => {
            const csv = buildBankFile(bankLines([
                row({ record: 'r1', amount: 500 }),
                row({ record: 'r2', amount: 300 }),
            ], 'CBE'));

            const dataRows = csv.trim().split('\n').slice(1);
            expect(dataRows).toEqual(['Almaz Tesfaye,1000123456789,,800']);
        });

        it('never sends an unticked row', () => {
            const csv = buildBankFile(bankLines([
                row({ record: 'r1', amount: 500 }),
                row({ record: 'r2', amount: 99999, included: false }),
            ], 'CBE'));

            expect(csv).not.toContain('99999');
        });

        it('sends only the bank it was asked for', () => {
            const rows = [
                row({ record: 'r1', bankAccount: { bankName: 'CBE', accountNumber: '1' } }),
                row({ record: 'r2', accountHolder: 'h2', accountHolderName: 'Bekele', bankAccount: { bankName: 'Awash', accountNumber: '2' } }),
            ];

            expect(bankNames(rows)).toEqual(['Awash', 'CBE']);
            expect(buildBankFile(bankLines(rows, 'Awash')).trim().split('\n')[1])
                .toBe('Bekele,2,,500');
        });

        it('never sends a row with no account number', () => {
            const rows = [
                row({ record: 'r1', bankAccount: null, included: true }),
            ];
            expect(bankLines(rows, 'CBE')).toEqual([]);
        });

        it('carries every note through, joined, rather than dropping any', () => {
            const csv = buildBankFile(bankLines([
                row({ record: 'r1', note: 'backdated' }),
                row({ record: 'r2', note: 'school fees' }),
                row({ record: 'r3', note: null }),
            ], 'CBE'));

            // A semicolon needs no quoting - the join only earns quotes when a
            // note actually contains a comma, a quote or a newline.
            expect(csv.trim().split('\n')[1]).toBe('Almaz Tesfaye,1000123456789,backdated; school fees,1500');
        });

        it('is empty of data rows for a month where everything was unticked', () => {
            const csv = buildBankFile(bankLines([row({ included: false })], 'CBE'));
            expect(csv.trim().split('\n')).toEqual([COLUMNS.join(',')]);
        });

        it('does not care whether bank details have drifted', () => {
            // Drift is surfaced on screen, but what was approved is what pays.
            const drifted = annotateDrift([row()], { r1: { _id: 'h1', name: 'Almaz', banks: [{ bankName: 'CBE', accountNumber: '9999' }] } });
            expect(drifted[0].bankDetailsChanged).toBe(true);
            expect(bankLines(drifted, 'CBE')[0].accountNumber).toBe('1000123456789');
        });
    });
});