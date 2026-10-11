const {
    GraphQLObjectType, GraphQLNonNull, GraphQLList, GraphQLString, GraphQLInt,
} = require('graphql');
const mongoose = require('mongoose');
const { assertFinance } = require('../../auth/requireFinance');
const SetMonthlyAllowanceInput = require('./schemas/setAllowanceInput');
const SetAccountHolderInput = require('./schemas/setAccountHolderInput');

// Payments data lives on the beneficiary, but is deliberately unreachable through
// the ordinary Record operations: Record is not finance-guarded, so exposing the
// allowance there would tell every role that can read a beneficiary how much they
// are paid, and would let an admin change it. Everything finance needs is here
// instead, behind one guard applied to every resolver in this file.

const BankAccountType = new GraphQLObjectType({
    name: 'PaymentBankAccount',
    fields: () => ({
        _id: { type: GraphQLString },
        bankName: { type: GraphQLString },
        accountNumber: { type: GraphQLString },
    }),
});

const AccountHolderType = new GraphQLObjectType({
    name: 'PaymentAccountHolder',
    fields: () => ({
        id: { type: GraphQLString },
        name: { type: GraphQLString },
        banks: { type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(BankAccountType))) },
    }),
});

const AllowanceChangeType = new GraphQLObjectType({
    name: 'AllowanceChange',
    fields: () => ({
        amount: { type: GraphQLInt },
        previousAmount: { type: GraphQLInt },
        note: { type: GraphQLString },
        changedBy: { type: GraphQLString },
        // Serialised as an ISO string. graphql 15's core does not export a
        // datetime scalar, and the frontend only ever renders this.
        changedAt: { type: GraphQLString },
    }),
});

const PaymentProfileType = new GraphQLObjectType({
    name: 'PaymentProfile',
    fields: () => ({
        id: { type: GraphQLString },
        registrationId: { type: GraphQLString },
        name: { type: GraphQLString },
        fatherName: { type: GraphQLString },
        gFatherName: { type: GraphQLString },
        status: { type: GraphQLString },
        monthlyAllowance: { type: GraphQLInt },
        accountHolderId: { type: GraphQLString },
        accountHolder: {
            type: AccountHolderType,
            resolve: source => source.accountHolder || null,
        },
        allowanceHistory: {
            type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(AllowanceChangeType))),
            resolve: source => source.allowanceHistory || [],
        },
    }),
});

const AllowanceResultType = new GraphQLObjectType({
    name: 'SetMonthlyAllowancePayload',
    fields: () => ({
        id: { type: GraphQLString },
        monthlyAllowance: { type: GraphQLInt },
    }),
});

const AccountHolderResultType = new GraphQLObjectType({
    name: 'SetAccountHolderPayload',
    fields: () => ({
        id: { type: GraphQLString },
        accountHolderId: { type: GraphQLString },
    }),
});

module.exports = function registerPaymentFields(schemaComposer) {
    const Record = mongoose.model('Record');

    const shapeProfile = record => {
        if (!record) return null;
        return {
            id: record._id.toString(),
            registrationId: record.registrationId || null,
            name: record.name || null,
            fatherName: record.fatherName || null,
            gFatherName: record.gFatherName || null,
            status: record.status || null,
            monthlyAllowance: typeof record.monthlyAllowance === 'number'
                ? record.monthlyAllowance
                : null,
            accountHolder: record.accountHolder && record.accountHolder._id
                ? {
                    id: record.accountHolder._id.toString(),
                    name: record.accountHolder.name,
                    banks: (record.accountHolder.banks || []).map(bank => ({
                        _id: bank._id ? bank._id.toString() : null,
                        bankName: bank.bankName,
                        accountNumber: bank.accountNumber,
                    })),
                }
                : null,
            allowanceHistory: (record.allowanceHistory || []).map(entry => ({
                amount: entry.amount,
                previousAmount: entry.previousAmount,
                note: entry.note || null,
                changedBy: entry.changedBy ? entry.changedBy.toString() : null,
                changedAt: entry.changedAt,
            })),
        };
    };

    schemaComposer.Query.addFields({
        paymentProfile: {
            type: PaymentProfileType,
            args: { id: 'MongoID!' },
            resolve: async (source, args, context) => {
                assertFinance(context);
                const record = await Record.findById(args.id)
                    .populate('accountHolder')
                    .populate('allowanceHistory.changedBy');
                if (!record) {
                    throw new Error('No such beneficiary.');
                }
                return shapeProfile(record);
            },
        },
    });

    schemaComposer.Mutation.addFields({
        // The only way the standing allowance changes. Writing it through the
        // ordinary record update would bypass both the role check and the
        // history, and either of those is enough to make the number untrustworthy.
        setMonthlyAllowance: {
            type: AllowanceResultType,
            args: {
                record: { type: new GraphQLNonNull(SetMonthlyAllowanceInput) },
            },
            resolve: async (source, args, context) => {
                assertFinance(context);

                const amount = args.record.amount;
                if (amount !== null && amount !== undefined && !Number.isInteger(amount)) {
                    throw new Error('The monthly allowance must be a whole number of birr.');
                }
                if (amount < 0) {
                    throw new Error('The monthly allowance cannot be negative.');
                }

                const user = context.ctx.state.user;
                const record = await Record.findById(args.record.id);
                if (!record) {
                    throw new Error('No such beneficiary.');
                }

                record.allowanceHistory.push({
                    amount: amount === undefined ? null : amount,
                    previousAmount: typeof record.monthlyAllowance === 'number'
                        ? record.monthlyAllowance
                        : null,
                    note: args.record.note || undefined,
                    changedBy: user._id,
                    changedAt: new Date(),
                });

                record.monthlyAllowance = amount === undefined ? undefined : amount;
                await record.save();

                return { id: record._id.toString(), monthlyAllowance: record.monthlyAllowance ?? null };
            },
        },

        setBeneficiaryAccountHolder: {
            type: AccountHolderResultType,
            args: {
                record: { type: new GraphQLNonNull(SetAccountHolderInput) },
            },
            resolve: async (source, args, context) => {
                assertFinance(context);

                const record = await Record.findById(args.record.id);
                if (!record) {
                    throw new Error('No such beneficiary.');
                }

                if (args.record.accountHolder) {
                    const holder = await mongoose.model('AccountHolder').findById(args.record.accountHolder);
                    if (!holder) {
                        throw new Error('No such account holder.');
                    }
                    record.accountHolder = holder._id;
                } else {
                    record.accountHolder = undefined;
                }

                record.modifiedBy = context.ctx.state.user._id;
                await record.save();

                return {
                    id: record._id.toString(),
                    accountHolderId: record.accountHolder ? record.accountHolder.toString() : null,
                };
            },
        },
    });
};