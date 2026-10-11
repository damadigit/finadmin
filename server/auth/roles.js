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

module.exports = { PAYMENT_ROLES, hasPaymentRole };