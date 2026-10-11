const { hasPaymentRole, hasFinanceAdminRole } = require('./roles');

// Resolver middleware guarding the payments feature.
//
// It throws rather than returning an empty result, so a caller can tell
// "you may not do this" from "there is nothing there". An empty result would
// look identical to a quiet month and hide the refusal.
async function requireFinance(resolve, root, args, context, info) {
    assertFinance(context);
    return resolve(root, args, context, info);
}

// For hand-written resolvers, which get no middleware slot. Same rule, same
// error, so the refusal is identical whichever path a caller takes.
function assertFinance(context) {
    const ctx = context && context.ctx;
    const user = ctx && ctx.state && ctx.state.user;

    if (!hasPaymentRole(user)) {
        throw new Error('Forbidden: the payments feature is restricted to finance roles.');
    }
}

function assertFinanceAdmin(context) {
    assertFinance(context);
    const ctx = context && context.ctx;
    const user = ctx && ctx.state && ctx.state.user;

    if (!hasFinanceAdminRole(user)) {
        throw new Error('Forbidden: approving, reopening and closing a month are reserved to finance administrators.');
    }
}

module.exports = requireFinance;
module.exports.assertFinance = assertFinance;
module.exports.assertFinanceAdmin = assertFinanceAdmin;