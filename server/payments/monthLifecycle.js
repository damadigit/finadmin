// Lifecycle rules for a payment month, with no database in sight.
//
// These are the transitions that decide when money becomes committed, so they
// are kept as plain functions that can be read and tested side by side.

const STATUS = { DRAFT: 'Draft', APPROVED: 'Approved', PAID: 'Paid' };

// Which transitions are legal. Money only ever moves one way: a month is
// prepared, then approved, then settled. Going back is the administrator's call
// and is recorded, because it means a file may already have reached a bank.
const ALLOWED = {
    [STATUS.DRAFT]: [STATUS.APPROVED],
    [STATUS.APPROVED]: [STATUS.PAID, STATUS.DRAFT],
    [STATUS.PAID]: [STATUS.DRAFT],
};

function canTransition(from, to) {
    return (ALLOWED[from] || []).includes(to);
}

// A month cannot be approved while anything in it still needs resolving. This is
// the last point at which somebody is guaranteed to look.
function untickableRows(rows) {
    return (rows || []).filter(row => row.blocked);
}

function assertApprovable(rows) {
    const stuck = untickableRows(rows);
    if (stuck.length > 0) {
        const names = stuck.slice(0, 5).map(r => r.registrationId || String(r.record));
        const more = stuck.length > names.length ? `, and ${stuck.length - names.length} more` : '';
        throw new Error(
            `Cannot approve: ${stuck.length} beneficiary record(s) still need resolving (${names.join(', ')}${more}).`
        );
    }
}

// A month with nobody ticked in it is a month that would pay no one. Approving
// it is almost certainly a mistake rather than an intention.
function assertHasPayees(rows) {
    const ticked = (rows || []).filter(r => r.included);
    if (ticked.length === 0) {
        throw new Error('Cannot approve: no beneficiaries are ticked for payment.');
    }
}

module.exports = { STATUS, ALLOWED, canTransition, untickableRows, assertApprovable, assertHasPayees };