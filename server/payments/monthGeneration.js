// Generation rules for a payment month, with no database and no mongoose in
// sight. The money-critical decisions live here rather than in a resolver so
// they can be tested directly and exhaustively; the resolver's only job is to
// fetch the inputs and write the result.

const MONTH_NAMES = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
];

// Why a generated row cannot be ticked. A row that cannot be paid must never
// look like one that has simply been left alone, and must block approval.
const BLOCKED = {
    UNLINKED: 'unlinked',
    NO_BANK_ACCOUNT: 'no-bank-account',
    CHOOSE_BANK_ACCOUNT: 'choose-bank-account',
};

function monthLabel(month) {
    const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(month || '');
    if (!match) return null;
    return `${MONTH_NAMES[Number(match[2]) - 1]} ${match[1]}`;
}

// Whether this beneficiary belongs in a freshly generated month.
//
// A beneficiary with no allowance is simply absent - not everyone is paid an
// allowance - and that is not an error. A discontinued one is absent because
// they are no longer being supported.
function isEligible(record) {
    if (!record) return false;
    if (record.status && record.status !== 'Active') return false;
    const allowance = record.monthlyAllowance;
    return typeof allowance === 'number' && allowance > 0;
}

function bankDetailsMatch(row, holder) {
    if (!row.bankAccount) return true;
    if (!holder || !Array.isArray(holder.banks)) return false;
    return holder.banks.some(
        bank => bank.bankName === row.bankAccount.bankName
            && bank.accountNumber === row.bankAccount.accountNumber
    );
}

// Builds one row per eligible beneficiary, every row starting ticked.
//
// The receiving bank account is chosen here where there is no choice to make: a
// holder with a single account gets it automatically. A holder with several has
// to be decided per row, so the row is left unselected and flagged until finance
// picks one - a row with no account number must never reach the bank.
function buildRows(records, holdersByRecordId = {}) {
    return records.filter(isEligible).map(record => {
        const holder = holdersByRecordId[String(record._id)] || null;

        let bankAccount = null;
        let blocked = null;

        if (!holder) {
            blocked = BLOCKED.UNLINKED;
        } else if (!Array.isArray(holder.banks) || holder.banks.length === 0) {
            blocked = BLOCKED.NO_BANK_ACCOUNT;
        } else if (holder.banks.length === 1) {
            const bank = holder.banks[0];
            bankAccount = { bankName: bank.bankName, accountNumber: bank.accountNumber };
        } else {
            blocked = BLOCKED.CHOOSE_BANK_ACCOUNT;
        }

        return {
            record: String(record._id),
            registrationId: record.registrationId || null,
            name: record.name || null,
            fatherName: record.fatherName || null,

            // Snapshot. A later change to the standing allowance applies to
            // future months, never to this one.
            amount: record.monthlyAllowance,

            included: blocked === null,
            note: null,

            accountHolder: holder ? String(holder._id) : null,
            accountHolderName: holder ? holder.name || null : null,
            bankAccount,

            blocked,
            bankDetailsChanged: false,
        };
    });
}

// Applied when a month is read, not when it is generated. A corrected account
// number must apply to future months only: rewriting a generated one would
// change a payout that may already have been approved and sent to the bank.
// Flagging it lets finance see the discrepancy instead of it being silently
// applied or silently lost.
function annotateDrift(rows, holdersByRecordId = {}) {
    return rows.map(row => ({
        ...row,
        bankDetailsChanged: !bankDetailsMatch(row, holdersByRecordId[String(row.record)]),
    }));
}

// Merges ticked rows into one line per account holder, per bank.
//
// One bank line cannot describe two different amounts, and one account holder
// with two beneficiaries paid the same month should be a single transfer rather
// than two. Their notes are joined rather than dropped, so nothing is lost to
// the merge.
function aggregateRows(rows) {
    const byHolder = new Map();

    for (const row of rows) {
        if (!row.included || !row.bankAccount) continue;

        const key = `${row.accountHolder}::${row.bankAccount.bankName}`;
        if (!byHolder.has(key)) {
            byHolder.set(key, {
                accountHolderId: row.accountHolder,
                accountHolderName: row.accountHolderName,
                bankName: row.bankAccount.bankName,
                accountNumber: row.bankAccount.accountNumber,
                amount: 0,
                notes: [],
            });
        }
        const line = byHolder.get(key);
        line.amount += row.amount;
        if (row.note) line.notes.push(row.note);
    }

    return [...byHolder.values()].map(line => ({
        ...line,
        note: line.notes.join('; '),
    }));
}

// Whether a row can be ticked, given the account holder behind it.
//
// A row is blocked by the holder's state, not by anything finance did wrong, so
// this is recomputed whenever the holder changes rather than being trusted from
// generation time - picking a bank account can clear the last of it.
function blockedReason(row, holder) {
    if (!row || !row.accountHolder || !holder) return BLOCKED.UNLINKED;
    const banks = Array.isArray(holder.banks) ? holder.banks : [];
    if (banks.length === 0) return BLOCKED.NO_BANK_ACCOUNT;
    return null;
}

// Works out what a re-sync would do, without doing it.
//
// Finance has already made decisions on this list, so a re-sync must never take
// them away silently. Beneficiaries who have become eligible since the month was
// generated are added; everyone already on it is left exactly as finance left
// them. A beneficiary who has dropped off - allowance cleared, or discontinued
// - is only removed if finance never touched their row; if they did, removing it
// is reported rather than performed.
function planResync(existingRows, freshRows) {
    const freshByRecord = new Map(freshRows.map(row => [String(row.record), row]));
    const existingByRecord = new Map((existingRows || []).map(row => [String(row.record), row]));

    const added = [];
    const kept = [];
    const removed = [];
    const heldForReview = [];

    for (const fresh of freshRows) {
        const key = String(fresh.record);
        const existing = existingByRecord.get(key);

        if (!existing) {
            added.push(fresh);
            continue;
        }

        // Everything finance set is carried over verbatim. The one thing worth
        // re-reading is whether the beneficiary is still eligible at all.
        kept.push({
            ...existing,
            blocked: existing.blocked || fresh.blocked,
        });
    }

    for (const existing of existingRows || []) {
        if (freshByRecord.has(String(existing.record))) continue;

        const edited = existing.included === false
            || existing.note
            || (existing.editedAt !== undefined && existing.editedAt !== null);

        if (edited) {
            heldForReview.push(existing);
        } else {
            removed.push(existing);
        }
    }

    return { added, kept, removed, heldForReview };
}

module.exports = {
    MONTH_NAMES, BLOCKED, monthLabel, isEligible, buildRows, annotateDrift,
    aggregateRows, blockedReason, planResync,
};