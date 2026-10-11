const mongoose = require('mongoose');
const Schema = mongoose.Schema;

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