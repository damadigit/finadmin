const {
    GraphQLObjectType, GraphQLNonNull, GraphQLList, GraphQLString,
} = require('graphql');
const mongoose = require('mongoose');
const { assertUserManagement } = require('../../auth/requireUserManagement');
const {
    assertKnownRoles, assertHasRoles, assertSuperAdminRemains, assertNotSelfDemotion, SUPER_ADMIN,
} = require('../../users/roleLifecycle');

// Two mutations, both guarded, both narrow on purpose.
//
// The composed CRUD on User is deliberately missing the two things this page
// needs. `createUser` was removed by the escalation fix - with `password` gone
// from every user input the model required a credential no caller could supply,
// so the mutation could only ever error, and leaving it advertised was worse than
// removing it. And `roles` is stripped from the composed update inputs so that
// setUserRoles is the only way to reach a role, which is what lets it enforce
// the rules about the last super-admin.
//
// Neither capability is handed back by re-opening the composed paths. Re-adding
// `password` to CreateOneUserInput would put account takeover back on a general
// write path that every future composed mutation on this model would inherit;
// re-adding `roles` to UpdateByIdUserInput would let the exact call the
// escalation tests make step around both rules in roleLifecycle.

const MIN_PASSWORD_LENGTH = 8;

// The password is never stored or returned in the clear. It goes through the
// model's pre('save') hook, which bcrypts it, exactly as registration does. The
// payload deliberately carries no password field at all - not a masked one, none.
const CreateUserAccountPayload = new GraphQLObjectType({
    name: 'CreateUserAccountPayload',
    fields: () => ({
        id: { type: GraphQLString },
        email: { type: GraphQLString },
        roles: { type: new GraphQLList(GraphQLString) },
    }),
});

const SetUserRolesPayload = new GraphQLObjectType({
    name: 'SetUserRolesPayload',
    fields: () => ({
        id: { type: GraphQLString },
        email: { type: GraphQLString },
        roles: { type: new GraphQLList(GraphQLString) },
    }),
});

async function countOtherSuperAdmins(User, excludeIds) {
    const ids = (excludeIds || []).filter(Boolean);
    return User.countDocuments({ roles: SUPER_ADMIN, _id: { $nin: ids } });
}

module.exports = function registerUserFields(schemaComposer) {

    schemaComposer.Mutation.addFields({

        // Creates an account with a password the caller chooses.
        //
        // This is a deliberate re-add of a capability the escalation fix closed,
        // and it is confined to this one guarded mutation. A caller outside the
        // user-management boundary cannot reach it, and the roles they may grant
        // are validated against the same list the model's enum uses, so there is
        // no second copy of the roles to drift.
        createUserAccount: {
            type: CreateUserAccountPayload,
            args: {
                email: { type: new GraphQLNonNull(GraphQLString) },
                password: { type: new GraphQLNonNull(GraphQLString) },
                roles: { type: new GraphQLList(GraphQLString) },
            },
            resolve: async (source, args, context) => {
                assertUserManagement(context);

                assertKnownRoles(args.roles || []);

                if (!args.password || args.password.length < MIN_PASSWORD_LENGTH) {
                    throw new Error(
                        `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`
                    );
                }

                const User = mongoose.model('User');

                // An account created with no roles falls back to the schema's
                // default of handler, the least privileged role. Creating an
                // account is not the same as trusting somebody with anything.
                //
                // `roles` is only set when roles were actually sent. Assigning
                // undefined to an array path yields an empty array rather than
                // leaving the field unset, so the schema default never fires and
                // the account would be created with no powers at all - which is
                // not the same as least privilege, it is an account nobody can
                // do anything with.
                const user = new User({
                    email: args.email,
                    password: args.password,
                    ...(args.roles && args.roles.length ? { roles: args.roles } : {}),
                    // Stamped here because this resolver is hand-written and the
                    // authMiddleware that does this for composed resolvers never
                    // runs for it. The actor is the caller, read from the same
                    // context the guard just checked.
                    createdBy: context.ctx.state.user._id,
                    modifiedBy: context.ctx.state.user._id,
                });

                const saved = await user.save();

                return { id: String(saved._id), email: saved.email, roles: Array.from(saved.roles) };
            },
        },

        // Assigns a user's roles in full - the array sent is the array stored,
        // not a set of additions. A partial update of a permission list is
        // ambiguous to read and easy to get wrong in the interface, where
        // "uncheck one box" and "remove this one role" mean different things.
        setUserRoles: {
            type: SetUserRolesPayload,
            args: {
                userId: { type: 'MongoID!' },
                roles: { type: new GraphQLNonNull(new GraphQLList(GraphQLString)) },
            },
            resolve: async (source, args, context) => {
                assertUserManagement(context);

                assertKnownRoles(args.roles);
                assertHasRoles(args.roles);

                const User = mongoose.model('User');
                const target = await User.findById(args.userId);
                if (!target) {
                    throw new Error('No such user.');
                }

                const currentRoles = Array.from(target.roles);
                const actor = context.ctx.state.user;

                assertNotSelfDemotion({
                    actorId: actor && actor._id,
                    targetId: target._id,
                    currentRoles,
                    nextRoles: args.roles,
                });

                // Counted against everyone except this target, so downgrading one
                // of two super-admins is allowed and downgrading the last is not.
                const otherSuperAdmins = await countOtherSuperAdmins(User, [target._id]);

                assertSuperAdminRemains({
                    currentRoles,
                    nextRoles: args.roles,
                    otherSuperAdminCount: otherSuperAdmins,
                });

                target.roles = args.roles;
                // The one line that makes "who granted this role" answerable.
                // Stamped after every check has passed, so a refused change
                // leaves no trace of having been attempted against the record -
                // the attempt itself is not an event on the account.
                target.modifiedBy = actor && actor._id;
                const saved = await target.save();

                return { id: String(saved._id), email: saved.email, roles: Array.from(saved.roles) };
            },
        },
    });
};