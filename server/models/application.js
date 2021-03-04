


const mongoose = require('mongoose');
const Schema = mongoose.Schema;
const {EducationSchema, FamilySchema,StorySchema,PlaceSchema, AddressSchema} = require('./schemas.js')









const ApplicationSchema = new Schema({
    name: String,
    fatherName: String,
    gFatherName: String,
    gender: String,
    birthDate: Date,
    placeOfBirth: String,
    health: {
        generalCondition: String,
        remark: String,
        history: [String]
    },
    photo: String,
    currentEducation: EducationSchema,
    previousEducations: [EducationSchema],
    families: [FamilySchema],
    place: PlaceSchema,
    story: StorySchema,
    date: Date,
    address: AddressSchema,
    status: {
        type: String,
        enum: ['Pending', 'Waiting', 'Rejected', 'Accepted'],
        default: 'Pending'
    },
    processedBy: String,
    createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
    modifiedBy: { type: Schema.Types.ObjectId, ref: 'User' },






},{timestamps: true});

// ApplicationSchema.

ApplicationSchema.virtual('fullName').
get(function() { return `${this.name||''} ${this.fatherName||''} ${this.gFatherName||''}`; }).
set(function(v) {
    // `v` is the value being set, so use the value to set
    // `firstName` and `lastName`.
    const name = v.substring(0, v.indexOf(' '));
    const fatherName = v.substring(v.indexOf(' ') + 1);
    const gFatherName = v.substring(v.indexOf(' ') + 2);
    this.set({ name, fatherName, gFatherName });
});



module.exports = mongoose.model('Application', ApplicationSchema);
