const mongoose = require('mongoose');
const Schema = mongoose.Schema;

// A holder may have more than one account, and a payment names which one is
// used, so each entry keeps its own id rather than being an anonymous array.
const BankAccountSchema = new Schema({
    bankName: {
        type: String,
        required: true
    },
    accountNumber: {
        type: String,
        required: true
    },
});

const AccountHolderSchema = new Schema({
    // Deliberately a single free-text name. Account holders are the parents, and
    // the organisation does not split their names into parts the way it does for
    // beneficiaries.
    name: {
        type: String,
        required: true,
        trim: true
    },
    banks: [BankAccountSchema],
    createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
    modifiedBy: { type: Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });

module.exports = mongoose.model('AccountHolder', AccountHolderSchema);