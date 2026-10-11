const db = require('./helpers/db');
const gql = require('./helpers/graphql');
const { createUser, createRecord } = require('./helpers/factories');

// Proves the harness end to end: the real schema is composed from the real
// models, a request runs against the real resolvers, and the context that
// resolvers reach into is wired the same way production wires it.
describe('test harness', () => {
    let schema;

    beforeAll(async () => {
        await db.connect();
        db.loadModels();
        schema = db.getSchema();
    });

    afterAll(async () => {
        await db.disconnect();
    });

    beforeEach(async () => {
        await db.clearDatabase();
    });

    it('composes a schema from the registered models', () => {
        expect(schema.getQueryType().getFields()).toHaveProperty('allRecords');
        expect(schema.getMutationType().getFields()).toHaveProperty('createRecord');
    });

    it('reads and writes through the generated operations', async () => {
        await createRecord({ name: 'Hana', registrationId: 'ET-0001' });

        const data = await gql.run(schema, `{ allRecords { id name registrationId } }`);

        expect(data.allRecords).toHaveLength(1);
        expect(data.allRecords[0]).toMatchObject({ name: 'Hana', registrationId: 'ET-0001' });
    });

    // The operation name must contain lowercase "create": the audit middleware
    // matches on it case-sensitively.
    it('gives resolvers the authenticated user, so audit stamping works', async () => {
        const user = await createUser({ roles: ['admin'] });

        const data = await gql.run(
            schema,
            `
            mutation createRecord($record: CreateOneRecordInput!) {
                createRecord(record: $record) {
                    record { id createdBy }
                }
            }
            `,
            {
                variables: {
                    record: { name: 'Sara', fatherName: 'Mother', registrationId: 'ET-0002' },
                },
                user,
            }
        );

        const created = data.createRecord.record;
        expect(created.id).toBeTruthy();
        expect(created.createdBy).toBe(user._id.toString());
    });

    it('counts through the generated metadata query', async () => {
        await createRecord({ registrationId: 'ET-0003' });
        await createRecord({ registrationId: 'ET-0004' });

        const data = await gql.run(schema, `{ _allRecordsMeta { count } }`);

        expect(data._allRecordsMeta.count).toBe(2);
    });
});