const { schemaComposer } = require('graphql-compose');
const { GraphQLNonNull, GraphQLList, GraphQLString } = require('graphql');
const mongoose = require('mongoose');
const buildSchema  = require('./mongooseQL')

const {ModelTC:ApplicationModelTC} = buildSchema('Application',schemaComposer)
//     }
//
// );

const {ModelTC:RecordModelTC} = buildSchema('Record',schemaComposer);
const {ModelTC:VisitModelTC}  = buildSchema('Visit',schemaComposer);
const {ModelTC:PostModelTC}  = buildSchema('Post',schemaComposer);

// Payment side of the system. AccountHolder is reachable from a beneficiary's
// payments panel, so it is composed here alongside the rest.
//
// Both are guarded in the resolver, not just hidden in the interface: these are
// the first models in the application that a role can be refused access to.
const requireFinance = require('../../auth/requireFinance');
const requireUserManagement = require('../../auth/requireUserManagement');
const { isSuperAdmin, assertNotLastSuperAdmin, SUPER_ADMIN } = require('../../users/roleLifecycle');

// The last super-admin cannot be deleted.
//
// Granting super-admin is itself a user-management action, so stripping it from
// every account disables user management permanently: there is nobody left who
// can put it back. This counts super-admins OTHER THAN the ones being removed,
// so deleting one of two is allowed and deleting the last is not.
//
// It is the model's deleteGuard rather than a check inside a purpose-built
// resolver because that covers the bulk paths as well as the single-document
// one. A guard placed only on a hand-written deleteUser would leave
// deleteOneUser and deleteManyUser open as a way round it.
//
// A guard that cannot see its targets must not wave them through. The remove
// filters carry `_operators`, `OR` and `AND`, none of which mean anything to a
// plain find() - passing one straight through matches nothing, finds no
// targets, returns early, and deletes the last super-admin anyway. That was not
// hypothetical: `deleteOneUser(filter: { _operators: { email: { in: [...] } } })`
// removed the only super-admin in the installation before this was fixed.
//
// So the failure mode is deliberately inverted. Rather than reason about filters
// it cannot evaluate, the guard refuses them and asks for a deletion it can
// check. Refusing a delete that would have been fine is an inconvenience;
// allowing one that should never have happened is a permanent lockout.

// `_ids` is a graphql-compose-mongoose convention rather than a Mongo field, so
// it is translated to $in for the same reason.
const UNEVALUABLE_FILTER_KEYS = ['_operators', 'OR', 'AND'];

function deleteTargetsFrom(args) {
    if (args._id) return { _id: args._id };

    const filter = args.filter;
    if (!filter) return null;

    const unevaluable = UNEVALUABLE_FILTER_KEYS.filter(key => filter[key] !== undefined);
    if (unevaluable.length > 0) {
        throw new Error(
            `Cannot delete with a filter using ${unevaluable.join(', ')}: the check for the last `
            + 'super-admin cannot see through it. Delete accounts one at a time by id.'
        );
    }

    if (Array.isArray(filter._ids)) return { _id: { $in: filter._ids } };

    return filter;
}

const refuseDeletingLastSuperAdmin = async (args) => {
    const query = deleteTargetsFrom(args);
    if (!query) return;

    const User = mongoose.model('User');
    const targets = await User.find(query).select('roles');
    if (targets.length === 0) return;

    const removing = targets.filter(doc => isSuperAdmin(doc.roles)).length;
    if (removing === 0) return;

    const total = await User.countDocuments({ roles: SUPER_ADMIN });

    assertNotLastSuperAdmin({
        targetRoles: [SUPER_ADMIN],
        otherSuperAdminCount: total - removing,
    });
};

// Accounts are the root of the permission model, so they are guarded rather than
// composed open. Composed without a guard, this single line let any signed-in
// user - a handler with no other powers - rewrite their own roles to financeAdmin,
// rewrite anyone else's password, and delete accounts outright. The guard is
// applied here rather than on the payments models because escalation defeats
// those guards: a user who can edit a user can grant themselves a role that gets
// past every one of them.
//
// The guard is now requireUserManagement rather than requireAdmin, because user
// management became its own boundary when super-admin was introduced. An
// administrator deciding who is trusted is a different power from an
// administrator editing beneficiary records, and merging them again would undo
// the split.
const {ModelTC:UserModelTC} = buildSchema('User',schemaComposer, {
    guards: [requireUserManagement],
    deleteGuard: refuseDeletingLastSuperAdmin,
});

// The password hash is removed from the User type and from every input that
// carries it.
//
// Two separate problems, one field. Reading it hands an attacker every account's
// hash to crack offline. Writing it lets the same attacker choose a new password
// for any account, which is account takeover whether or not they can read
// anything. Neither is reachable through the interface once the field is absent,
// so this is not a hiding of the UI but the removal of the capability itself.
const PASSWORD = 'password';
const ROLES = 'roles';

const userInputTypes = [
    'CreateOneUserInput', 'CreateManyUserInput',
    'UpdateByIdUserInput', 'UpdateOneUserInput', 'UpdateManyUserInput',
    'FilterUpdateOneUserInput', 'FilterUpdateManyUserInput',
    'FilterFindOneUserInput', 'FilterRemoveOneUserInput', 'FilterRemoveManyUserInput',
];

[UserModelTC, ...userInputTypes.map(name => schemaComposer.getAnyTC(name))]
    .filter(Boolean)
    .forEach(type => {
        if (type.getField(PASSWORD)) {
            type.removeField(PASSWORD);
        }
    });

// With password gone from the inputs, the composed create mutations can no longer
// produce a valid account: the model requires a password, so createUser would fail
// for every caller including an administrator. Rather than leave a mutation that
// only ever errors, it is removed.
//
// Accounts are created through registration, which hashes the password server-side
// and assigns the least privileged role, and roles are then granted
// administratively through updateUser. That is the same path self-registration
// already takes, so no capability is lost - a caller simply cannot now invent an
// account with a password of their choosing in one request.
schemaComposer.Mutation.removeField('createUser');
schemaComposer.Mutation.removeField('createManyUser');

// `roles` is removed from the composed update inputs for the same reason the
// allowance is removed from Record: a field that can bypass a hand-written
// mutation's invariant is an invariant that is not enforced.
//
// setUserRoles is where roles are changed, and it refuses to remove the last
// super-admin and refuses to let a caller demote themselves. Left on
// updateUser, either check could be stepped around by calling updateUser with a
// roles field instead - which is precisely the call the escalation tests already
// make. Email stays, so changing an address still goes through the ordinary
// composed path.
//
// createdBy and modifiedBy are struck from the inputs for a different reason: an
// audit trail a caller can write is not an audit trail. mongooseQL's
// authMiddleware overwrites both on the way through, so a forged value would be
// discarded anyway, but relying on that is relying on the middleware running -
// and it does not run for the hand-written resolvers. Removing the fields makes
// the trail unwriteable from outside rather than merely overwritten.
//
// The create inputs are stripped too, even though createUser is gone: they are
// the inputs createUserAccount's counterpart would be built from, and leaving a
// writable role list on a type nothing uses is how it gets used later.
//
// Deduplicated because the create types appear in userInputTypes already, and
// removing a field twice is an error on an input type. hasField rather than
// getField because getField throws on an input type rather than returning
// undefined, which would make the removal order matter.
const STRIPPED_FROM_USER_INPUTS = [ROLES, 'createdBy', 'modifiedBy'];

[...new Set([...userInputTypes, 'CreateOneUserInput', 'CreateManyUserInput'])]
    .map(name => schemaComposer.getAnyTC(name))
    .filter(Boolean)
    .forEach(type => {
        STRIPPED_FROM_USER_INPUTS.forEach(field => {
            if (type.hasField(field)) {
                type.removeField(field);
            }
        });
    });

// An account holder that is still linked to a beneficiary cannot be deleted:
// the link is what a payment is made against, and silently dropping it would
// turn a paid beneficiary into an unexplained gap in the next month.
const refuseDeleteOfLinkedHolder = async (args) => {
    const query = args._id ? { _id: args._id } : args.filter;
    if (!query) return;

    const ids = (await mongoose.model('AccountHolder').find(query).select('_id')).map(d => d._id);
    if (ids.length === 0) return;

    const linked = await mongoose.model('Record').countDocuments({ accountHolder: { $in: ids } });

    if (linked > 0) {
        throw new Error(
            `Cannot delete: ${linked} beneficiary record(s) are still linked to this account holder. Detach them first.`
        );
    }
};

const {ModelTC:AccountHolderModelTC} = buildSchema('AccountHolder', schemaComposer, {
    guards: [requireFinance],
    deleteGuard: refuseDeleteOfLinkedHolder,
});
const {ModelTC:PaymentPeriodModelTC} = buildSchema('PaymentPeriod', schemaComposer, { guards: [requireFinance] });

// The allowance is removed from the Record type entirely - output and inputs.
// Record is readable and writable by every role, so leaving the amount on the
// type would tell handlers and sponsors what each beneficiary is paid, and
// leaving it on the inputs would let an admin rewrite it without any history
// entry. The finance-guarded payment operations are the only route to it.
['monthlyAllowance', 'allowanceHistory'].forEach(field => RecordModelTC.removeField(field));

// accountHolder stays readable as a bare id - an id on its own says nothing
// about anyone's money, and the payments panel needs it to know who is linked -
// but it is not settable here. Linking is a finance action and goes through the
// guarded mutation, so an admin cannot quietly re-point a beneficiary at a
// different account.
const RECORD_INPUTS_ONLY = ['monthlyAllowance', 'allowanceHistory', 'accountHolder'];

// Input types are named after the model, so they can be reached by name once the
// resolvers that use them have been built.
RECORD_INPUTS_ONLY.forEach(field => {
    ['CreateOneRecordInput', 'UpdateByIdRecordInput', 'UpdateOneRecordInput',
        'FilterUpdateOneRecordInput', 'FilterFindOneRecordInput']
        .map(name => schemaComposer.getAnyTC(name))
        .filter(Boolean)
        .forEach(type => {
            if (type.getField(field)) {
                type.removeField(field);
            }
        });
});

require('./payments')(schemaComposer);
require('./users')(schemaComposer);
RecordModelTC.addFields({
 fullName: 'String',
 // Deliberately pinned to an id rather than the composed AccountHolder type.
 // Record is not finance-guarded, so expanding the reference here would hand
 // holder names and bank details to every role that can read a beneficiary.
 // Without this line the exposed type would depend on whether AccountHolder was
 // composed before or after Record, which is not something a security property
 // should rest on. The frontend resolves the holder through the guarded
 // AccountHolder operations instead.
 accountHolder: 'MongoID',
})

ApplicationModelTC.addFields({
 fullName: 'String'
})


VisitModelTC.addFields({
 age: 'Int'
})
// require('./schemas/profile')
// require('./mongooseQL')('Company',schemaComposer);
//addEntityNameRegexpSearch()
//
// const Item = mongoose.model('Item');
// const ItemTC = composeWithMongoose(Item);
//
// const entity = item
//
// schemaComposer.Query.addFields({
//     item: ItemTC.getResolver('findById'),
//     itemByIds: ItemTC.getResolver('findByIds'),
//     itemOne: ItemTC.getResolver('findOne'),
//     itemMany: ItemTC.getResolver('findMany'),
//     itemCount: ItemTC.getResolver('count'),
//     itemConnection: ItemTC.getResolver('connection'),
//     itemPagination: ItemTC.getResolver('pagination'),
// });
//
// schemaComposer.Mutation.addFields({
//     itemCreateOne: ItemTC.getResolver('createOne'),
//     itemCreateMany: ItemTC.getResolver('createMany'),
//     itemUpdateById: ItemTC.getResolver('updateById'),
//     itemUpdateOne: ItemTC.getResolver('updateOne'),
//     itemUpdateMany: ItemTC.getResolver('updateMany'),
//     itemRemoveById: ItemTC.getResolver('removeById'),
//     itemRemoveOne: ItemTC.getResolver('removeOne'),
//     itemRemoveMany: ItemTC.getResolver('removeMany'),
// });

const RecordModel = mongoose.model('Record');

schemaComposer.Query.addFields({
    uniqueRecordAreas: {
        type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(GraphQLString))),
        resolve: async () => {
            const result = await RecordModel.distinct('place.address.area');
            return result.filter(Boolean).sort();
        },
    },
    uniqueRecordSubcities: {
        type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(GraphQLString))),
        resolve: async () => {
            const result = await RecordModel.distinct('place.address.subcity');
            return result.filter(Boolean).sort();
        },
    },
});

const graphqlSchema = schemaComposer.buildSchema();
module.exports = graphqlSchema;













// const {gql } = require('apollo-server-hapi');
//
//
// module.exports = gql`
// type Item {
//   id: String
//   name: String
// }
//
// type Item {
//   name: String
// }
//
// type Query {
//   items: [Item]
//   item(id: String): Item
// }
// `;





// const graphql = require('graphql')
// const {GraphQLObjectType, GraphQLString, GraphQLSchema} = graphql;
// const ItemType = require('./ItemType');
// const mongoose = require('mongoose');
//
// const RootQuery = new GraphQLObjectType (
//     {
//         name: 'RootQueryType',
//         fields: {
//             item: {
//                 type: ItemType,
//                 args: {id: {type: GraphQLString}},
//                 resolve(parent, args) {
//
//                     return  mongoose.model('Item').findById(args.id)
//
//                 }
//             }
//         }
//     }
// )
//
// module.exports = new GraphQLSchema({
//     query: RootQuery
// });
