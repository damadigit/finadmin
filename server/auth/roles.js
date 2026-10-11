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

// Who may decide what happens to beneficiary records.
//
// This was the account boundary before super-admin existed and is kept so that
// the boundary and the role that used to own it still read together. Both are
// now unused by any guard: requireAdmin is no longer wired to anything, and
// user management belongs to USER_MANAGEMENT_ROLES below. Neither is deleted,
// because removing them is a separate cleanup and this file is meant to be read
// as the whole permission model at once.
const ADMIN_ROLES = ['admin'];

function hasAdminRole(user) {
    const roles = (user && user.roles) || [];
    return ADMIN_ROLES.some(role => roles.includes(role));
}

// Who may manage users: create accounts, assign roles, delete accounts.
//
// This is a third boundary, not an extension of the one above. 'admin' decides
// what may be done with beneficiary records; super-admin decides who else is
// trusted at all. Keeping them apart is what stops an administrator from minting
// an administrator, and it is why the role split was worth making before the
// page existed rather than after.
//
// 'admin' is in this list TEMPORARILY and must be removed once a super-admin
// account exists. Until then nobody holds the role that is supposed to own user
// management, so administrators are admitted alongside it to make the handover
// possible - an administrator uses the new Users page to promote themselves to
// superAdmin, and only then is this list narrowed to ['superAdmin'].
//
// Nothing fails if that never happens. The page works, the tests pass, and the
// two roles are indistinguishable. The entry is only visible to someone reading
// it, so remove it deliberately rather than at the end of a feature.
//
// The matching client-side condition is canManageUsers in
// finadmin_ui/src/helpers/roles.js - NOT App.js, which only calls it. Both must
// be changed together.
const USER_MANAGEMENT_ROLES = ['superAdmin', 'admin'];

function hasUserManagementRole(user) {
    const roles = (user && user.roles) || [];
    return USER_MANAGEMENT_ROLES.some(role => roles.includes(role));
}

module.exports = {
    PAYMENT_ROLES, PAYMENT_ADMIN_ROLES, ADMIN_ROLES, USER_MANAGEMENT_ROLES,
    hasPaymentRole, hasFinanceAdminRole, hasAdminRole, hasUserManagementRole,
};
