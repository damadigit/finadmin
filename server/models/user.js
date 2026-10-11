const mongoose = require('mongoose');
const bcrypt   = require('bcrypt-nodejs');
const { ALL_ROLES } = require('../users/roleLifecycle');

const UserSchema = new mongoose.Schema({

    email: {
        type: String,
        lowercase: true,
        unique: true,
        required: true
    },
    password: {
        type: String,
        required: true,
        select: false
    },
    // The default belongs on the array path, not inside the element definition.
    //
    // Both shapes are easy to write and both are wrong here. `roles: [{ type:
    // String, default: 'handler' }]` sets the default of each ELEMENT, so an
    // empty array stays empty. `roles: { type: [{ type: String }], default:
    // 'handler' }` casts the scalar to [] rather than to ['handler']. Either way
    // the default never fired, and any account created without explicit roles
    // came out with no powers at all - which is not least privilege, it is an
    // account nobody can do anything with. Registration masked it by always
    // passing a role; nothing else did.
    roles: {
        type: [{
            type: String,
            // finance prepares a payment month; financeAdmin additionally
            // approves, reopens and marks one paid. Neither role grants access
            // to anything else in the application.
            //
            // super-admin manages users. It is the only role that can grant
            // roles, which is what stops an administrator from minting an
            // administrator - note that 'admin' reaches user management only
            // while the handover in server/auth/roles.js is still open, because
            // no super-admin exists yet.
            //
            // The list is imported rather than written out here so that a
            // mutation validating a role and the database accepting it are the
            // same list.
            enum: ALL_ROLES,
        }],
        default: ['handler'],
    },

    // Who created the account, and who last changed it.
    //
    // Every other mutable document in this codebase carries these, and accounts
    // were the one place the question is asked most often and answered least.
    // "Who granted financeAdmin, and when" is the first thing anybody wants
    // after something goes wrong, and it was unanswerable.
    //
    // They are stamped by the resolvers rather than by the client. `updateUser`
    // is stamped by the authMiddleware in api/graphql/mongooseQL.js like every
    // other model; createUserAccount and setUserRoles stamp them by hand,
    // because a hand-written resolver gets no help from that middleware. Both
    // are also struck from the composed inputs, so a caller cannot write their
    // own version of who did it.
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    modifiedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }

}, {
    timestamps: true
});

UserSchema.pre('save', function(next){

    const user = this;
    const SALT_FACTOR = 5;

    if(!user.isModified('password')){
        return next();
    }

    bcrypt.genSalt(SALT_FACTOR, function(err, salt){

        if(err){
            return next(err);
        }

        bcrypt.hash(user.password, salt, null, function(err, hash){

            if(err){
                return next(err);
            }

            user.password = hash;
            next();

        });

    });

});

UserSchema.methods.comparePassword = function(passwordAttempt, cb){

    bcrypt.compare(passwordAttempt, this.password, function(err, isMatch){

        if(err){
            return cb(err);
        } else {
            cb(null, isMatch);
        }
    });

}

module.exports = mongoose.model('User', UserSchema);
