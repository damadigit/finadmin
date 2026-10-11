const {
    GraphQLObjectType, GraphQLNonNull, GraphQLList, GraphQLString, GraphQLInt, GraphQLBoolean,
    GraphQLInputObjectType,
} = require('graphql');
const mongoose = require('mongoose');
const { assertFinance, assertFinanceAdmin } = require('../../auth/requireFinance');
const SetMonthlyAllowanceInput = require('./schemas/setAllowanceInput');
const SetAccountHolderInput = require('./schemas/setAccountHolderInput');
const {
    monthLabel, buildRows, annotateDrift, blockedReason, planResync,
} = require('../../payments/monthGeneration');
const { buildBankFile, bankLines, bankNames } = require('../../payments/bankFile');
const {
    STATUS, canTransition, assertApprovable, assertHasPayees,
} = require('../../payments/monthLifecycle');

const GeneratePeriodInput = new GraphQLInputObjectType({
    name: 'GeneratePaymentPeriodInput',
    fields: { month: { type: GraphQLString } },
});

// Only the fields being changed need to be sent. An absent amount means "leave
// the amount alone", which is why the resolver checks for presence rather than
// reading a value that may be legitimately null.
const MonthInput = new GraphQLInputObjectType({
    name: 'PaymentMonthInput',
    fields: { month: { type: new GraphQLNonNull(GraphQLString) } },
});

const SyncPlanType = new GraphQLObjectType({
    name: 'PaymentResyncPlan',
    fields: () => ({
        added: { type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(PayoutRowType))) },
        removedCount: { type: GraphQLInt },
        heldForReviewCount: { type: GraphQLInt },
        unchangedCount: { type: GraphQLInt },
    }),
});

const ExportInput = new GraphQLInputObjectType({
    name: 'ExportBankFileInput',
    fields: {
        month: { type: new GraphQLNonNull(GraphQLString) },
        bankName: { type: new GraphQLNonNull(GraphQLString) },
    },
});

const ReopenInput = new GraphQLInputObjectType({
    name: 'ReopenPaymentPeriodInput',
    fields: {
        month: { type: new GraphQLNonNull(GraphQLString) },
        reason: { type: new GraphQLNonNull(GraphQLString) },
    },
});

const BankChoiceInput = new GraphQLInputObjectType({
    name: 'PaymentBankChoiceInput',
    fields: {
        bankName: { type: GraphQLString },
        accountNumber: { type: GraphQLString },
    },
});

const SetPayoutRowInput = new GraphQLInputObjectType({
    name: 'SetPayoutRowInput',
    fields: {
        month: { type: new GraphQLNonNull(GraphQLString) },
        record: { type: 'MongoID!' },
        included: { type: GraphQLBoolean },
        amount: { type: GraphQLInt },
        note: { type: GraphQLString },
        bankAccount: { type: BankChoiceInput },
    },
});

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

const SetPayoutRowPayload = new GraphQLObjectType({
    name: 'SetPayoutRowPayload',
    fields: () => ({
        month: { type: GraphQLString },
        updated: { type: GraphQLBoolean },
    }),
});

const BankFileType = new GraphQLObjectType({
    name: 'PaymentBankFile',
    fields: () => ({
        month: { type: GraphQLString },
        bankName: { type: GraphQLString },
        filename: { type: GraphQLString },
        contents: { type: GraphQLString },
        lineCount: { type: GraphQLInt },
    }),
});

const TransitionPayload = new GraphQLObjectType({
    name: 'PaymentPeriodTransitionPayload',
    fields: () => ({
        month: { type: GraphQLString },
        status: { type: GraphQLString },
        supersededExports: { type: GraphQLInt },
    }),
});

const PeriodResultType = new GraphQLObjectType({
    name: 'GeneratePaymentPeriodPayload',
    fields: () => ({
        id: { type: GraphQLString },
        month: { type: GraphQLString },
        label: { type: GraphQLString },
        status: { type: GraphQLString },
        rowCount: { type: GraphQLInt },
        untickableCount: { type: GraphQLInt },
    }),
});

// Rows are read through this rather than off the model directly, because the
// bank-detail drift flag has to be recomputed against the current state of each
// account holder every time the month is opened.
const PayoutRowType = new GraphQLObjectType({
    name: 'PaymentPayoutRow',
    fields: () => ({
        record: { type: GraphQLString },
        registrationId: { type: GraphQLString },
        name: { type: GraphQLString },
        fatherName: { type: GraphQLString },
        amount: { type: GraphQLInt },
        included: { type: GraphQLBoolean },
        note: { type: GraphQLString },
        accountHolderName: { type: GraphQLString },
        bankName: { type: GraphQLString },
        accountNumber: { type: GraphQLString },
        blocked: { type: GraphQLString },
        bankDetailsChanged: { type: GraphQLBoolean },
    }),
});

const PaymentMonthType = new GraphQLObjectType({
    name: 'PaymentMonth',
    fields: () => ({
        id: { type: GraphQLString },
        month: { type: GraphQLString },
        label: { type: GraphQLString },
        status: { type: GraphQLString },
        approvedAt: { type: GraphQLString },
        paidAt: { type: GraphQLString },
        rows: { type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(PayoutRowType))) },
    }),
});

module.exports = function registerPaymentFields(schemaComposer) {
    const Record = mongoose.model('Record');
    const AccountHolder = mongoose.model('AccountHolder');
    const PaymentPeriod = mongoose.model('PaymentPeriod');

    // What the beneficiary list would produce if this month were generated now.
    const freshRowsFor = async month => {
        const records = await Record.find({ monthlyAllowance: { $gt: 0 } }).lean();
        const holderIds = [...new Set(
            records.map(r => (r.accountHolder ? String(r.accountHolder) : null)).filter(Boolean)
        )];
        const holders = holderIds.length
            ? await AccountHolder.find({ _id: { $in: holderIds } }).lean()
            : [];
        const byHolderId = Object.fromEntries(holders.map(h => [String(h._id), h]));

        const byRecordId = {};
        records.forEach(record => {
            if (record.accountHolder) byRecordId[String(record._id)] = byHolderId[String(record.accountHolder)];
        });

        return buildRows(records, byRecordId);
    };

    // Loads the holders behind a set of rows and re-flags any whose bank details
    // have been corrected since the month was generated.
    const withDrift = async rows => {
        const holderIds = [...new Set(rows.map(r => r.accountHolder).filter(Boolean).map(String))];
        if (holderIds.length === 0) return annotateDrift(rows, {});

        const holders = await AccountHolder.find({ _id: { $in: holderIds } }).lean();
        const byHolderId = Object.fromEntries(holders.map(h => [String(h._id), h]));

        const byRecordId = {};
        rows.forEach(row => {
            if (row.accountHolder) byRecordId[String(row.record)] = byHolderId[String(row.accountHolder)];
        });

        return annotateDrift(rows, byRecordId);
    };

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
        previewPaymentPeriodResync: {
            type: SyncPlanType,
            args: { record: { type: new GraphQLNonNull(MonthInput) } },
            resolve: async (source, args, context) => {
                assertFinance(context);

                const period = await PaymentPeriod.findOne({ month: args.record.month });
                if (!period) throw new Error('That month has not been generated.');
                if (period.status !== STATUS.DRAFT) {
                    throw new Error('Only a draft month can be re-synced.');
                }

                const fresh = await freshRowsFor(period.month);
                const plan = planResync((period.rows || []).map(r => (r.toObject ? r.toObject() : r)), fresh);

                return {
                    added: plan.added,
                    removedCount: plan.removed.length,
                    heldForReviewCount: plan.heldForReview.length,
                    unchangedCount: plan.kept.length,
                };
            },
        },


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

        // Reading a month always recomputes the bank-detail drift, so finance
        // sees a corrected account number as a discrepancy rather than having it
        // silently applied to a month that may already have been paid.
        paymentMonth: {
            type: PaymentMonthType,
            args: { month: { type: GraphQLNonNull(GraphQLString) } },
            resolve: async (source, args, context) => {
                assertFinance(context);

                const period = await PaymentPeriod.findOne({ month: args.month });
                if (!period) {
                    throw new Error('That month has not been generated.');
                }

                const rows = await withDrift((period.rows || []).map(r => r.toObject ? r.toObject() : r));

                return {
                    id: period._id.toString(),
                    month: period.month,
                    label: period.label,
                    status: period.status,
                    approvedAt: period.approvedAt ? period.approvedAt.toISOString() : null,
                    paidAt: period.paidAt ? period.paidAt.toISOString() : null,
                    rows: rows.map(row => ({
                        ...row,
                        bankName: row.bankAccount ? row.bankAccount.bankName : null,
                        accountNumber: row.bankAccount ? row.bankAccount.accountNumber : null,
                    })),
                };
            },
        },
    });

    schemaComposer.Mutation.addFields({
        // The whole tick list runs through here: ticking, un-ticking, a per-month
        // amount, a note, and choosing which of a holder's accounts pays.
        setPayoutRow: {
            type: SetPayoutRowPayload,
            args: { record: { type: new GraphQLNonNull(SetPayoutRowInput) } },
            resolve: async (source, args, context) => {
                assertFinance(context);

                const input = args.record;
                const period = await PaymentPeriod.findOne({ month: input.month });
                if (!period) {
                    throw new Error('That month has not been generated.');
                }

                // Everything about a month freezes at approval. Refusing here is
                // what makes an approved month genuinely unchangeable rather
                // than merely discouraged.
                if (period.status !== 'Draft') {
                    throw new Error(
                        `This month is ${period.status.toLowerCase()} and can no longer be changed. Reopen it first.`
                    );
                }

                const row = period.rows.find(r => String(r.record) === String(input.record));
                if (!row) {
                    throw new Error('That beneficiary is not in this month.');
                }

                const holder = row.accountHolder
                    ? await AccountHolder.findById(row.accountHolder).lean()
                    : null;

                if (input.bankAccount) {
                    const banks = holder && Array.isArray(holder.banks) ? holder.banks : [];
                    const chosen = banks.find(
                        b => b.bankName === input.bankAccount.bankName
                            && b.accountNumber === input.bankAccount.accountNumber
                    );
                    if (!chosen) {
                        throw new Error('That account is not one of this account holder\'s accounts.');
                    }
                    row.bankAccount = {
                        bankName: chosen.bankName,
                        accountNumber: chosen.accountNumber,
                    };
                }

                // Recomputed from the holder rather than trusted from generation:
                // choosing a bank account is what clears the last obstacle on a
                // row that was waiting for one.
                row.blocked = blockedReason(row, holder);

                if ('amount' in input && input.amount !== undefined) {
                    if (!Number.isInteger(input.amount) || input.amount < 0) {
                        throw new Error('A monthly amount must be a whole number of birr, zero or more.');
                    }
                    // This month's amount only. The standing allowance is a
                    // separate thing and is deliberately left alone.
                    row.amount = input.amount;
                }

                if ('note' in input && input.note !== undefined) {
                    row.note = input.note;
                }

                if (input.included === true && row.blocked) {
                    throw new Error(
                        `This row cannot be ticked until it is resolved (${row.blocked.replace(/-/g, ' ')}).`
                    );
                }
                if (input.included !== undefined) {
                    row.included = input.included;
                }

                period.modifiedBy = context.ctx.state.user._id;
                await period.save();

                return { month: period.month, updated: true };
            },
        },

        // ---- lifecycle -------------------------------------------------------
        // Approve is the point money becomes committed. It is deliberately the
        // one transition a plain finance officer cannot perform.

        // ---- the bank file ---------------------------------------------------

        // Reads the rows exactly as approved. Bank details that have drifted
        // since generation are surfaced on screen, but what was approved is what
        // pays - quietly substituting a corrected account number here would pay
        // something nobody approved.
        // ---- re-sync ---------------------------------------------------------

        // Refresh is not this: it reloads the list and changes nothing.
        // Re-sync goes back to the beneficiaries and works out what it would do,
        // which is shown before any of it is applied.

        resyncPaymentPeriod: {
            type: TransitionPayload,
            args: { record: { type: new GraphQLNonNull(MonthInput) } },
            resolve: async (source, args, context) => {
                assertFinance(context);

                const period = await PaymentPeriod.findOne({ month: args.record.month });
                if (!period) throw new Error('That month has not been generated.');
                if (period.status !== STATUS.DRAFT) {
                    throw new Error('Only a draft month can be re-synced.');
                }

                const fresh = await freshRowsFor(period.month);
                const plan = planResync((period.rows || []).map(r => (r.toObject ? r.toObject() : r)), fresh);

                // Rows finance had already touched are kept exactly as they are.
                // Removing one would silently undo a decision somebody made -
                // the whole point of previewing the change first is that the
                // re-sync reports what it would do and lets finance decide.
                period.rows = [...plan.kept, ...plan.heldForReview, ...plan.added];
                period.modifiedBy = context.ctx.state.user._id;
                await period.save();

                return {
                    month: period.month,
                    status: period.status,
                    supersededExports: 0,
                };
            },
        },

        exportBankFile: {
            type: BankFileType,
            args: { record: { type: new GraphQLNonNull(ExportInput) } },
            resolve: async (source, args, context) => {
                assertFinance(context);

                const period = await PaymentPeriod.findOne({ month: args.record.month });
                if (!period) throw new Error('That month has not been generated.');

                if (period.status === STATUS.DRAFT) {
                    throw new Error('A month must be approved before a bank file can be taken from it.');
                }

                const rows = (period.rows || []).map(r => (r.toObject ? r.toObject() : r));
                const lines = bankLines(rows, args.record.bankName);
                const available = bankNames(rows);

                if (available.length && !available.includes(args.record.bankName)) {
                    throw new Error(`This month has nothing to pay at ${args.record.bankName}.`);
                }

                const contents = buildBankFile(lines);
                const user = context.ctx.state.user;

                period.exports.push({
                    bankName: args.record.bankName,
                    exportedBy: user._id,
                    exportedAt: new Date(),
                    superseded: false,
                });
                await period.save();

                return {
                    month: period.month,
                    bankName: args.record.bankName,
                    filename: `${period.month}-${args.record.bankName.replace(/[^A-Za-z0-9]+/g, '-')}.csv`,
                    contents,
                    lineCount: lines.length,
                };
            },
        },

        approvePaymentPeriod: {
            type: TransitionPayload,
            args: { month: { type: new GraphQLNonNull(GraphQLString) } },
            resolve: async (source, args, context) => {
                assertFinanceAdmin(context);

                const period = await PaymentPeriod.findOne({ month: args.month });
                if (!period) throw new Error('That month has not been generated.');

                if (!canTransition(period.status, STATUS.APPROVED)) {
                    throw new Error(`This month is already ${period.status.toLowerCase()}.`);
                }

                assertApprovable(period.rows);
                assertHasPayees(period.rows);

                period.status = STATUS.APPROVED;
                period.approvedBy = context.ctx.state.user._id;
                period.approvedAt = new Date();
                period.modifiedBy = period.approvedBy;
                await period.save();

                return { month: period.month, status: period.status, supersededExports: 0 };
            },
        },

        markPaymentPeriodPaid: {
            type: TransitionPayload,
            args: { month: { type: new GraphQLNonNull(GraphQLString) } },
            resolve: async (source, args, context) => {
                assertFinanceAdmin(context);

                const period = await PaymentPeriod.findOne({ month: args.month });
                if (!period) throw new Error('That month has not been generated.');

                if (!canTransition(period.status, STATUS.PAID)) {
                    throw new Error('A month can only be marked paid once it has been approved.');
                }

                period.status = STATUS.PAID;
                period.paidBy = context.ctx.state.user._id;
                period.paidAt = new Date();
                period.modifiedBy = period.paidBy;
                await period.save();

                return { month: period.month, status: period.status, supersededExports: 0 };
            },
        },

        reopenPaymentPeriod: {
            type: TransitionPayload,
            args: { record: { type: new GraphQLNonNull(ReopenInput) } },
            resolve: async (source, args, context) => {
                assertFinanceAdmin(context);

                const period = await PaymentPeriod.findOne({ month: args.record.month });
                if (!period) throw new Error('That month has not been generated.');

                if (!canTransition(period.status, STATUS.DRAFT)) {
                    throw new Error('A month that is still a draft does not need reopening.');
                }

                const reason = (args.record.reason || '').trim();
                if (!reason) {
                    throw new Error('Reopening a month requires a reason.');
                }

                // A file already taken from this month is now stale, and reusing
                // it would pay the wrong amounts. Kept, but marked superseded.
                const superseded = (period.exports || []).filter(e => !e.superseded).length;
                (period.exports || []).forEach(e => { e.superseded = true; });

                period.status = STATUS.DRAFT;
                period.reopenedBy = context.ctx.state.user._id;
                period.reopenedAt = new Date();
                period.reopenReason = reason;
                period.approvedBy = undefined;
                period.approvedAt = undefined;
                period.modifiedBy = period.reopenedBy;
                await period.save();

                return { month: period.month, status: period.status, supersededExports: superseded };
            },
        },

        generatePaymentPeriod: {
            type: PeriodResultType,
            args: { record: { type: new GraphQLNonNull(GeneratePeriodInput) } },
            resolve: async (source, args, context) => {
                assertFinance(context);

                const month = args.record.month;
                const label = monthLabel(month);
                if (!label) {
                    throw new Error(`"${month}" is not a month. Use the form 2026-08.`);
                }

                if (await PaymentPeriod.findOne({ month })) {
                    throw new Error(`${label} has already been generated.`);
                }

                // Only pre-filter on the allowance; eligibility itself, including
                // the discontinuation check, is decided by the pure rules.
                const records = await Record.find({ monthlyAllowance: { $gt: 0 } }).lean();

                // String(undefined) is the string "undefined", which would sail through a
                // truthiness check and fail as an ObjectId further down, so
                // unlinked records have to be dropped before converting.
                const holderIds = [...new Set(
                    records.map(r => (r.accountHolder ? String(r.accountHolder) : null)).filter(Boolean)
                )];
                const holders = holderIds.length
                    ? await AccountHolder.find({ _id: { $in: holderIds } }).lean()
                    : [];
                const byHolderId = Object.fromEntries(holders.map(h => [String(h._id), h]));

                const holdersByRecordId = {};
                records.forEach(record => {
                    if (record.accountHolder) {
                        holdersByRecordId[String(record._id)] = byHolderId[String(record.accountHolder)];
                    }
                });

                const rows = buildRows(records, holdersByRecordId);

                const user = context.ctx.state.user;
                const period = await PaymentPeriod.create({
                    month,
                    label,
                    status: 'Draft',
                    rows,
                    createdBy: user._id,
                    modifiedBy: user._id,
                });

                return {
                    id: period._id.toString(),
                    month: period.month,
                    label: period.label,
                    status: period.status,
                    rowCount: rows.length,
                    untickableCount: rows.filter(r => r.blocked).length,
                };
            },
        },

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