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

    it('leaves everything finance already decided exactly as it is', () => {
        const existing = [row('r1', { included: false, note: 'left the area', amount: 0 })];
        const plan = planResync(existing, [row('r1', { amount: 500, note: null, included: true })]);

        expect(plan.added).toEqual([]);
        expect(plan.kept).toEqual(existing);
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

    it('does not silently replace a bank account a row already carries', () => {
        const existing = [
            row('r1', { bankAccount: { bankName: 'Awash', accountNumber: '100' } }),
        ];
        const plan = planResync(existing, [
            row('r1', { bankAccount: { bankName: 'CBE', accountNumber: '200' } }),
        ]);

        expect(plan.kept[0].bankAccount).toEqual({ bankName: 'Awash', accountNumber: '100' });
    });

    it('never overwrites a per-month amount adjustment', () => {
        const existing = [row('r1', { amount: 900 })];
        const plan = planResync(existing, [row('r1', { amount: 500 })]);

        expect(plan.kept[0].amount).toBe(900);
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

        expect(plan).toEqual({ added: [], kept: rows, removed: [], heldForReview: [] });
    });

    it('copes with an empty month', () => {
        expect(planResync([], [])).toEqual({ added: [], kept: [], removed: [], heldForReview: [] });
    });
});