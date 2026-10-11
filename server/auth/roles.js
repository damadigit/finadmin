// Roles permitted to reach anything in the payments feature.
//
// This is the whole of the payments permission model. It is enforced in the
// resolvers, not in the interface, so hiding a menu item is never what provides
// the protection. Roles outside this list get a permission error even if they
// call the API directly.
const PAYMENT_ROLES = ['finance', 'financeAdmin'];

function hasPaymentRole(user) {
    const roles = (user && user.roles) || [];
    return PAYMENT_ROLES.some(role => roles.includes(role));
}

// Approving, reopening and marking a month paid are reserved to the second
// role. Preparing a month and committing to it are deliberately different
// powers: the people who assemble a payout should not be the people who sign it
// off, because approving your own work is the weakness a finance feature is most
// exposed to.
const PAYMENT_ADMIN_ROLES = ['financeAdmin'];

function hasFinanceAdminRole(user) {
    const roles = (user && user.roles) || [];
    return PAYMENT_ADMIN_ROLES.some(role => roles.includes(role));
}

// Who may administer accounts.
//
// This is deliberately separate from the finance boundary. A payment role is
// trusted with bank details and allowances; being trusted with those does not
// make somebody the person who decides who else is trusted. Keeping them apart
// means a finance officer cannot promote themselves, and a compromised finance
// account cannot mint an administrator.
const ADMIN_ROLES = ['admin'];

function hasAdminRole(user) {
    const roles = (user && user.roles) || [];
    return ADMIN_ROLES.some(role => roles.includes(role));
}

module.exports = {
    PAYMENT_ROLES, PAYMENT_ADMIN_ROLES, ADMIN_ROLES,
    hasPaymentRole, hasFinanceAdminRole, hasAdminRole,
};
