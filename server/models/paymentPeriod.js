const mongoose = require('mongoose');
const Schema = mongoose.Schema;

// The receiving bank account, frozen into the row at generation. `blocked`
// records why a row cannot be ticked; an untickable row blocks approval, so it
// must never be confused with one that was simply left alone.
const PayoutRowSchema = new Schema({
    record: { type: Schema.Types.ObjectId, ref: 'Record' },
    // Snapshot of the beneficiary's identity, so a month still reads correctly
    // if the beneficiary is renamed or discontinued afterwards.
    registrationId: String,
    name: String,
    fatherName: String,

    // Snapshot of the standing allowance, adjustable for this month alone.
    amount: {
        type: Number,
        validate: {
            validator: v => v === undefined || v === null || Number.isInteger(v),
            message: 'A monthly amount must be a whole number of birr.'
        }
    },

    // The tick. The note beside it means different things either way: on a
    // ticked row it reaches the bank, on an unticked one it records why.
    included: { type: Boolean, default: true },
    note: String,

    accountHolder: { type: Schema.Types.ObjectId, ref: 'AccountHolder' },
    accountHolderName: String,
    bankAccount: {
        bankName: String,
        accountNumber: String
    },

    blocked: String,
    bankDetailsChanged: { type: Boolean, default: false },
}, { _id: false });

// Every export taken for this month, kept even after a reopen marks them
// superseded, so there is an answer to "which file went to the bank, and when".
const ExportSchema = new Schema({
    bankName: String,
    exportedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    exportedAt: { type: Date, default: Date.now },
    superseded: { type: Boolean, default: false },
}, { _id: false });

// One document per payment month. The payout rows live inside it rather than in
// their own collection: the month is the unit finance works in, the rows are only
// ever read and written alongside it, and approving a month is then a single
// atomic write rather than a transaction across documents.
const PaymentPeriodSchema = new Schema({
    // Machine key, '2026-08'. Unique, so a month cannot be generated twice.
    month: {
        type: String,
        required: true,
        unique: true,
        match: /^\d{4}-(0[1-9]|1[0-2])$/
    },
    // What people read, 'August 2026'.
    label: {
        type: String,
        required: true
    },
    status: {
        type: String,
        enum: ['Draft', 'Approved', 'Paid'],
        default: 'Draft'
    },
    rows: [PayoutRowSchema],
    exports: [ExportSchema],
    approvedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    approvedAt: Date,
    reopenedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    reopenedAt: Date,
    reopenReason: String,
    paidBy: { type: Schema.Types.ObjectId, ref: 'User' },
    paidAt: Date,
    createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
    modifiedBy: { type: Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });

module.exports = mongoose.model('PaymentPeriod', PaymentPeriodSchema);