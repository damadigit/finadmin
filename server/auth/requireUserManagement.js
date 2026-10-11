const { hasUserManagementRole } = require('./roles');

// Resolver middleware guarding user management.
//
// Replaces requireAdmin on the User model. Accounts remain the root of the
// permission model: a user who can edit a user can hand themselves any role,
// which makes every other guard in the system advisory. This is therefore the
// one guard that cannot be bypassed by reaching the composed CRUD rather than a
// purpose-built resolver.
async function requireUserManagement(resolve, root, args, context, info) {
    assertUserManagement(context);
    return resolve(root, args, context, info);
}

function assertUserManagement(context) {
    const ctx = context && context.ctx;
    const user = ctx && ctx.state && ctx.state.user;

    if (!hasUserManagementRole(user)) {
        throw new Error('Forbidden: managing accounts is restricted to user managers.');
    }
}

module.exports = requireUserManagement;
module.exports.assertUserManagement = assertUserManagement;