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
buildSchema('User',schemaComposer);

// Payment side of the system. AccountHolder is reachable from a beneficiary's
// payments panel, so it is composed here alongside the rest.
//
// Both are guarded in the resolver, not just hidden in the interface: these are
// the first models in the application that a role can be refused access to.
const requireFinance = require('../../auth/requireFinance');

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
