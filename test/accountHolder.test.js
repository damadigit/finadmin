const db = require('./helpers/db');
const gql = require('./helpers/graphql');
const { createUser } = require('./helpers/factories');

describe('account holders', () => {
    let schema;
    let user;

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
        user = await createUser({ roles: ['finance'] });
    });

    // Operation names carry the verb in lower case: the audit middleware matches
    // on the operation name, case-sensitively.
    const createAccountHolder = `
        mutation createAccountHolder($record: CreateOneAccountHolderInput!) {
            createAccountHolder(record: $record) {
                record { id name banks { _id bankName accountNumber } createdBy }
            }
        }
    `;

    const updateAccountHolder = `
        mutation updateAccountHolder($record: UpdateByIdAccountHolderInput!) {
            updateAccountHolder(record: $record) {
                record { id name banks { _id bankName accountNumber } modifiedBy }
            }
        }
    `;

    it('creates a holder with any number of bank accounts', async () => {
        const data = await gql.run(schema, createAccountHolder, {
            user,
            variables: {
                record: {
                    name: 'Almaz Tesfaye',
                    banks: [
                        { bankName: 'CBE', accountNumber: '1000123456789' },
                        { bankName: 'Awash', accountNumber: '2000234567890' },
                    ],
                },
            },
        });

        const created = data.createAccountHolder.record;
        expect(created.name).toBe('Almaz Tesfaye');
        expect(created.banks).toHaveLength(2);
        expect(created.banks.map(b => b.bankName)).toEqual(['CBE', 'Awash']);
        expect(created.createdBy).toBe(user._id.toString());
    });

    it('accepts a single name with no family or grandfather name', async () => {
        const data = await gql.run(schema, createAccountHolder, {
            user,
            variables: { record: { name: 'Almaz', banks: [] } },
        });

        expect(data.createAccountHolder.record.name).toBe('Almaz');
    });

    it('requires a name', async () => {
        await expect(
            gql.run(schema, createAccountHolder, {
                user,
                variables: { record: { name: '   ', banks: [] } },
            })
        ).rejects.toThrow();
    });

    it('lists holders with their bank accounts', async () => {
        await gql.run(schema, createAccountHolder, {
            user,
            variables: { record: { name: 'Almaz', banks: [{ bankName: 'CBE', accountNumber: '1' }] } },
        });
        await gql.run(schema, createAccountHolder, {
            user,
            variables: { record: { name: 'Bekele', banks: [] } },
        });

        const data = await gql.run(
            schema,
            `{ allAccountHolders { id name banks { _id bankName accountNumber } } }`,
            { user }
        );

        expect(data.allAccountHolders).toHaveLength(2);
        const almaz = data.allAccountHolders.find(h => h.name === 'Almaz');
        expect(almaz.banks).toHaveLength(1);
    });

    it('counts holders through the metadata query', async () => {
        await gql.run(schema, createAccountHolder, { user, variables: { record: { name: 'A', banks: [] } } });
        await gql.run(schema, createAccountHolder, { user, variables: { record: { name: 'B', banks: [] } } });

        const data = await gql.run(schema, `{ _allAccountHoldersMeta { count } }`, { user });

        expect(data._allAccountHoldersMeta.count).toBe(2);
    });

    it('adds and removes bank accounts on edit, stamping who changed it', async () => {
        const created = await gql.run(schema, createAccountHolder, {
            user,
            variables: { record: { name: 'Almaz', banks: [{ bankName: 'CBE', accountNumber: '1' }] } },
        });
        const id = created.createAccountHolder.record.id;

        const data = await gql.run(schema, updateAccountHolder, {
            user,
            variables: {
                record: {
                    _id: id,
                    banks: [
                        { bankName: 'Dashen', accountNumber: '3' },
                        { bankName: 'Nib', accountNumber: '4' },
                    ],
                },
            },
        });

        const updated = data.updateAccountHolder.record;
        expect(updated.banks).toHaveLength(2);
        expect(updated.banks.map(b => b.bankName)).toEqual(['Dashen', 'Nib']);
        expect(updated.modifiedBy).toBe(user._id.toString());
    });

    it('rejects a bank account with no bank name or no account number', async () => {
        await expect(
            gql.run(schema, createAccountHolder, {
                user,
                variables: { record: { name: 'Almaz', banks: [{ accountNumber: '1' }] } },
            })
        ).rejects.toThrow();
    });

    // The exact query the Account Holders page opens with, written out as
    // graphDataProvider builds it.
    //
    // It sorts by name, and graphql-compose-mongoose only offers a sort order
    // for fields that carry an index - it reads the schema's `_index` flags, not
    // the collection's real indexes. `name` had no index, so the enum held only
    // _ID_ASC and the page failed to load with "Value NAME_ASC does not exist in
    // SortFindManyAccountHolderInput". Nothing on the server was broken by that;
    // the page simply could not ask for the order it wanted.
    //
    // Asserted two ways on purpose. The enum check says the field is offered for
    // sorting; the query check says the resolver honours it. A schema change
    // that drops the index again fails here rather than in the browser.
    it('offers and serves a sort by name, which is what the list page asks for', async () => {
        const sortValues = schema.getType('SortFindManyAccountHolderInput')
            .getValues().map(v => v.name);
        expect(sortValues).toContain('NAME_ASC');

        await gql.run(schema, createAccountHolder, {
            user,
            variables: { record: { name: 'Zewditu', banks: [{ bankName: 'Dashen', accountNumber: '1' }] } },
        });
        await gql.run(schema, createAccountHolder, {
            user,
            variables: { record: { name: 'Almaz', banks: [{ bankName: 'Nib', accountNumber: '2' }] } },
        });

        const data = await gql.run(schema, `
            query allAccountHolders($filter: FilterFindManyAccountHolderInput, $sort: SortFindManyAccountHolderInput, $skip: Int, $limit: Int) {
                items: allAccountHolders(filter: $filter, sort: $sort, skip: $skip, limit: $limit) {
                    id
                    name
                    banks { _id bankName accountNumber }
                    createdBy
                    modifiedBy
                }
                total: _allAccountHoldersMeta(filter: $filter) { count }
            }
        `, { user, variables: { sort: 'NAME_ASC', skip: 0, limit: 50 } });

        expect(data.total.count).toBe(2);
        expect(data.items.map(h => h.name)).toEqual(['Almaz', 'Zewditu']);
    });
});