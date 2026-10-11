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
// what may be done with beneficiary records; superAdmin decides who else is
// trusted at all. Keeping them apart is what stops an administrator from minting
// an administrator, and it is why the role split was worth making before the
// page existed rather than after.
//
// The handover is closed. This list briefly also carried 'admin', because no
// superAdmin account existed yet and without one nobody could reach the page
// that appoints the first. A superAdmin now exists, so an administrator is once
// again refused here - which is the whole point of the split. If this ever has
// to be reopened, admit 'admin' again, appoint a superAdmin, then take it back
// out; do not leave it in, because with both admitted the two roles are
// indistinguishable and nothing fails to say so.
//
// The matching client-side condition is canManageUsers in
// finadmin_ui/src/helpers/roles.js - NOT App.js, which only calls it. Both must
// be changed together.
const USER_MANAGEMENT_ROLES = ['superAdmin'];

function hasUserManagementRole(user) {
    const roles = (user && user.roles) || [];
    return USER_MANAGEMENT_ROLES.some(role => roles.includes(role));
}

module.exports = {
    PAYMENT_ROLES, PAYMENT_ADMIN_ROLES, ADMIN_ROLES, USER_MANAGEMENT_ROLES,
    hasPaymentRole, hasFinanceAdminRole, hasAdminRole, hasUserManagementRole,
};
