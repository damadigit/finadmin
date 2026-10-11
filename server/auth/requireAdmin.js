const { hasAdminRole } = require('./roles');

// Resolver middleware guarding account administration.
//
// Accounts are the root of the permission model: a user who can edit a user can
// hand themselves any role, which makes every other guard in the system advisory.
// This is therefore the one guard that cannot be bypassed by reaching the
// composed CRUD rather than a purpose-built resolver.
async function requireAdmin(resolve, root, args, context, info) {
    assertAdmin(context);
    return resolve(root, args, context, info);
}

function assertAdmin(context) {
    const ctx = context && context.ctx;
    const user = ctx && ctx.state && ctx.state.user;

    if (!hasAdminRole(user)) {
        throw new Error('Forbidden: managing accounts is restricted to administrators.');
    }
}

module.exports = requireAdmin;
module.exports.assertAdmin = assertAdmin;