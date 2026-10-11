// Rules about who may hold which role, and about the one way the permission
// model can break itself.
//
// Pure and database-free so it can be unit-tested directly, in the same way as
// server/payments/monthLifecycle.js. The resolvers call into it and let it
// throw; nothing here knows about Mongoose or GraphQL.

// The complete set of roles. server/models/user.js uses this for its enum so
// that the model and the validation a mutation performs cannot drift apart -
// validating against a second copy of this list is how a role ends up that the
// database rejects and nobody can explain.
//
// The super-admin role is spelled 'superAdmin', not 'super-admin', and that is
// not a style preference. graphql-compose-mongoose turns the model's enum into a
// GraphQL enum, and a GraphQL enum value cannot contain a hyphen: 'super-admin'
// comes back out of the API as 'super_admin' while the database still holds
// 'super-admin'. The interface would then be holding a role the database has
// never heard of, and sending it back would fail validation on a model that was
// correct all along. The camelCase spelling also matches the tier it sits beside,
// finance and financeAdmin.
const ALL_ROLES = [
    'admin', 'handler', 'sponsor', 'etAdmin', 'beAdmin',
    'finance', 'financeAdmin', 'superAdmin',
];

const SUPER_ADMIN = 'superAdmin';

function rolesOf(roles) {
    return Array.isArray(roles) ? roles : [];
}

function isSuperAdmin(roles) {
    return rolesOf(roles).includes(SUPER_ADMIN);
}

function assertKnownRoles(roles) {
    const unknown = rolesOf(roles).filter(role => !ALL_ROLES.includes(role));
    if (unknown.length > 0) {
        throw new Error(`Unknown role: ${unknown.join(', ')}. Valid roles are ${ALL_ROLES.join(', ')}.`);
    }
}

// An account with no roles is not "least privileged", it is unusable - it cannot
// read a beneficiary, cannot reach payments, cannot do anything at all. That is
// almost always a slip in the picker rather than an intent, and it is the kind of
// state nobody notices until the person complains they can see nothing.
//
// Enforced here rather than only in the interface, because the interface is not
// what protects the system. Creating an account is exempt: there the absence of
// roles means "use the default", and the model supplies handler.
function assertHasRoles(roles) {
    if (rolesOf(roles).length === 0) {
        throw new Error('A user must have at least one role.');
    }
}

// Adding super-admin created a way to break the installation permanently:
// strip it from every account and nobody can put it back, because granting it is
// itself a user-management action. Every write that could remove the last
// super-admin has to check, and every one of those checks reduces to the same
// question - after this write, is anybody left who can do user management?
//
// The count passed in is deliberately "super-admins OTHER THAN the ones this
// write is touching", so that downgrading one of two is allowed and downgrading
// the last is not. Counting everyone would make the second-to-last unreachable.
function assertSuperAdminRemains({ currentRoles, nextRoles, otherSuperAdminCount }) {
    if (isSuperAdmin(currentRoles) && !isSuperAdmin(nextRoles) && otherSuperAdminCount === 0) {
        throw new Error(
            'Cannot remove super-admin: this is the last one. Appoint another super-admin first.'
        );
    }
}

function assertNotLastSuperAdmin({ targetRoles, otherSuperAdminCount }) {
    if (isSuperAdmin(targetRoles) && otherSuperAdminCount === 0) {
        throw new Error(
            'Cannot delete: this is the last super-admin. Appoint another super-admin first.'
        );
    }
}

// Two super-admins demoting each other in the same sitting still reaches zero, so
// the count check alone does not cover self-demotion. A caller may never drop
// super-admin from their own account; the cost is that demoting the last-but-one
// super-admin needs a second super-admin to do it.
function assertNotSelfDemotion({ actorId, targetId, currentRoles, nextRoles }) {
    const sameAccount = actorId && targetId && String(actorId) === String(targetId);

    if (sameAccount && isSuperAdmin(currentRoles) && !isSuperAdmin(nextRoles)) {
        throw new Error(
            'Cannot remove super-admin from your own account. Ask another super-admin to do it.'
        );
    }
}

module.exports = {
    ALL_ROLES, SUPER_ADMIN,
    isSuperAdmin, assertKnownRoles, assertHasRoles,
    assertSuperAdminRemains, assertNotLastSuperAdmin, assertNotSelfDemotion,
};