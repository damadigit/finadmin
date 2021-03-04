const mongoose = require('mongoose');
const Schema = mongoose.Schema;
const StaffSchema = new Schema({
    name: String,
    photo: String,
    fatherName: String,
    gFatherName: String,
    gender: String,
    email: {
        type: String,
        lowercase: true,
        unique: true,
        required: true
    },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
    modifiedBy: { type: Schema.Types.ObjectId, ref: 'User' },

},{timestamps: true})


module.exports = mongoose.model('Staff', StaffSchema);
