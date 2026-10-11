const { aggregateRows } = require('./monthGeneration');

// The exact shape the bank expects. Column names and order are not ours to
// choose - get them wrong and the upload is rejected - so they are written out
// here once rather than assembled at the call site.

const COLUMNS = ['Account Holder Name', 'Account Number', 'Note', 'Amount'];

function escapeField(value) {
    const text = value === null || value === undefined ? '' : String(value);
    if (/[",\r\n]/.test(text)) {
        return `"${text.replace(/"/g, '""')}"`;
    }
    return text;
}

// UTF-8 with no byte-order mark, LF endings, a header row, no total row, and
// amounts as bare integers with no separators or currency symbol. Banks parse
// the amount as a number; anything else either fails or, worse, is read as text.
function buildBankFile(lines) {
    const rows = [COLUMNS.join(',')];

    for (const line of lines) {
        rows.push([
            escapeField(line.accountHolderName),
            escapeField(line.accountNumber),
            escapeField(line.note),
            String(line.amount),
        ].join(','));
    }

    return `${rows.join('\n')}\n`;
}

// Lines for one bank, out of a month's rows. One line per account holder: the
// same holder paid for two beneficiaries is one transfer, not two.
function bankLines(rows, bankName) {
    return aggregateRows(rows).filter(line => line.bankName === bankName);
}

function bankNames(rows) {
    // Deliberately not bankLines(rows) with no filter: that path compares
    // against an undefined bank and matches nothing.
    return [...new Set(aggregateRows(rows).map(line => line.bankName))].sort();
}

module.exports = { COLUMNS, escapeField, buildBankFile, bankLines, bankNames };