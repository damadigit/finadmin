const { planResync } = require('../server/payments/monthGeneration');

const row = (record, overrides = {}) => ({
    record,
    registrationId: `ET-${record}`,
    amount: 500,
    included: true,
    note: null,
    accountHolderName: 'Almaz',
    blocked: null,
    ...overrides,
});

describe('planning a re-sync', () => {
    it('adds a beneficiary who has become eligible since the month was generated', () => {
        const plan = planResync([row('r1')], [row('r1'), row('r2')]);

        expect(plan.added.map(r => r.record)).toEqual(['r2']);
        expect(plan.removed).toEqual([]);
    });

    it('keeps the decisions finance made and refreshes the amount', () => {
        const existing = [row('r1', { included: false, note: 'left the area', amount: 0 })];
        const plan = planResync(existing, [row('r1', { amount: 500, note: null, included: true })]);

        expect(plan.added).toEqual([]);
        expect(plan.kept[0]).toMatchObject({
            included: false,
            note: 'left the area',
            amount: 500,
        });
    });

    it('never re-enables a row finance unticked', () => {
        const existing = [row('r1', { included: false })];
        const plan = planResync(existing, [row('r1')]);

        expect(plan.kept[0].included).toBe(false);
    });

    it('clears a block whose cause finance has since fixed, and fills the account in', () => {
        const existing = [
            row('r1', { blocked: 'unlinked', accountHolderName: null, bankAccount: null }),
        ];
        const plan = planResync(existing, [
            row('r1', {
                accountHolderName: 'Almaz',
                bankAccount: { bankName: 'Awash', accountNumber: '100' },
            }),
        ]);

        expect(plan.kept[0].blocked).toBeNull();
        expect(plan.kept[0].accountHolderName).toBe('Almaz');
        expect(plan.kept[0].bankAccount).toEqual({ bankName: 'Awash', accountNumber: '100' });
    });

    it("adopts the holder's corrected account when the stored one has drifted", () => {
        const existing = [
            row('r1', { bankAccount: { bankName: 'Awash', accountNumber: '100' } }),
        ];
        const fresh = [
            row('r1', { bankAccount: { bankName: 'CBE', accountNumber: '200' } }),
        ];
        // The holder has moved to a single new account; the old one is gone.
        const holders = { r1: { _id: 'h1', banks: [{ bankName: 'CBE', accountNumber: '200' }] } };

        const plan = planResync(existing, fresh, holders);

        expect(plan.kept[0].bankAccount).toEqual({ bankName: 'CBE', accountNumber: '200' });
    });

    it('keeps a bank account finance chose while the holder still has it', () => {
        const existing = [
            row('r1', { bankAccount: { bankName: 'Awash', accountNumber: '100' } }),
        ];
        // The holder now has two accounts, so a fresh row would choose neither.
        const fresh = [row('r1', { bankAccount: null, blocked: 'choose-bank-account' })];
        const holders = {
            r1: {
                _id: 'h1',
                banks: [
                    { bankName: 'Awash', accountNumber: '100' },
                    { bankName: 'CBE', accountNumber: '200' },
                ],
            },
        };

        const plan = planResync(existing, fresh, holders);

        expect(plan.kept[0].bankAccount).toEqual({ bankName: 'Awash', accountNumber: '100' });
        expect(plan.kept[0].blocked).toBeNull();
    });

    it("refreshes the amount from the beneficiary's current standing allowance", () => {
        const existing = [row('r1', { amount: 900 })];
        const plan = planResync(existing, [row('r1', { amount: 500 })]);

        expect(plan.kept[0].amount).toBe(500);
        expect(plan.revaluedCount).toBe(1);
    });

    it('reports no amount change when the allowance is unchanged', () => {
        const plan = planResync([row('r1', { amount: 500 })], [row('r1', { amount: 500 })]);

        expect(plan.revaluedCount).toBe(0);
    });

    it('removes a beneficiary who dropped off, if nobody touched their row', () => {
        const plan = planResync([row('r1'), row('r2')], [row('r1')]);

        expect(plan.removed.map(r => r.record)).toEqual(['r2']);
        expect(plan.heldForReview).toEqual([]);
    });

    it('holds back a dropped row that finance unticked or annotated', () => {
        const plan = planResync(
            [row('r1'), row('r2', { included: false })],
            [row('r1')]
        );

        expect(plan.removed).toEqual([]);
        expect(plan.heldForReview.map(r => r.record)).toEqual(['r2']);
    });

    it('holds back a dropped row that carries a note', () => {
        const plan = planResync([row('r2', { note: 'held for review' })], []);
        expect(plan.heldForReview.map(r => r.record)).toEqual(['r2']);
    });

    it('reports an addition alongside a removal in one plan', () => {
        const plan = planResync([row('r1')], [row('r2')]);

        expect(plan.added.map(r => r.record)).toEqual(['r2']);
        expect(plan.removed.map(r => r.record)).toEqual(['r1']);
    });

    it('does nothing when nothing has changed', () => {
        const rows = [row('r1'), row('r2')];
        const plan = planResync(rows, rows);

        expect(plan).toEqual({ added: [], kept: rows, removed: [], heldForReview: [], revaluedCount: 0 });
    });

    it('copes with an empty month', () => {
        expect(planResync([], [])).toEqual({ added: [], kept: [], removed: [], heldForReview: [], revaluedCount: 0 });
    });
});