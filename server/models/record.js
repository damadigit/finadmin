


const mongoose = require('mongoose');
const {PostSchema} = require("./schemas");
const {EducationSchema, FamilySchema,StorySchema,PlaceSchema, SponsorSchema,AddressSchema} = require('./schemas.js')
const Schema = mongoose.Schema;

// Appended on every allowance change. Without it, `modifiedBy` on the record
// only tells you the beneficiary was touched at some point - not what the amount
// was, or what it became.
const AllowanceChangeSchema = new Schema({
    amount: Number,
    previousAmount: Number,
    note: String,
    changedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    changedAt: { type: Date, default: Date.now },
}, { _id: false });



const RecordSchema = new Schema({
    application: { type: Schema.Types.ObjectId, ref: 'Application' },
    // The parent who receives this beneficiary's allowance. Siblings share one
    // holder, so many records point at the same one. Only meaningful to the
    // payments feature; null for every beneficiary who has never been linked.
    accountHolder: { type: Schema.Types.ObjectId, ref: 'AccountHolder' },
    registrationId: {
        type:String,
        unique:true
    },
    homeId: String,
    official: {
        type:Boolean,
        default: true
    },
    name: String,
    photo: String,
    fatherName: String,
    gFatherName: String,
    gender: String,
    birthDate: {
        type: Date,
        index: true
    },
    placeOfBirth: String,
    address: AddressSchema,
    health: {
        generalCondition: String,
        remark: String,
        history: [String]
    },
    exitInfo: {
        reason: String,
        remark: String,
        leaveLetter: String,
        date: Date,
    },
    currentEducation: EducationSchema,
    previousEducations: [EducationSchema],
    families: [FamilySchema],
    place: PlaceSchema,
    story: StorySchema,
    date: Date,
    status: {
        type: String,
        enum: ['Active', 'Discontinued'],
        default: 'Active'
    },
    processedBy: String,
    sponsor:SponsorSchema,
    // Payments data. Held on the beneficiary because the allowance belongs to
    // them, but stripped from the unguarded Record GraphQL type - only the
    // finance-guarded payment operations expose it.
    monthlyAllowance: {
        type: Number,
        min: 0,
        validate: {
            // Absent is fine - most beneficiaries have no allowance - but a
            // value that is present must be whole birr.
            validator: v => v === undefined || v === null || Number.isInteger(v),
            message: 'The monthly allowance must be a whole number of birr.'
        }
    },
    allowanceHistory: [AllowanceChangeSchema],
    createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
    modifiedBy: { type: Schema.Types.ObjectId, ref: 'User' },



}, {    timestamps: true});

RecordSchema.virtual('fullName').
get(function() { return `${this.name||''} ${this.fatherName||''} ${this.gFatherName||''}`; }).
set(function(v) {
    // `v` is the value being set, so use the value to set
    // `firstName` and `lastName`.
    const name = v.substring(0, v.indexOf(' '));
    const fatherName = v.substring(v.indexOf(' ') + 1);
    const gFatherName = v.substring(v.indexOf(' ') + 2);
    this.set({ name, fatherName, gFatherName });
});

RecordSchema.pre('save', async function(next){
   // console.log(this)
    this.homeId = this.registrationId
   if(this.application) {
       const Application = await mongoose.model('Application').findById(this.application);
       if(Application)
       {
           Application.status= "Accepted";
           await Application.save();
       }


   }
   next()
})

module.exports = mongoose.model('Record', RecordSchema);
