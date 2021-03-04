


const mongoose = require('mongoose');
const {EducationSchema, FamilySchema,StorySchema,PlaceSchema, SponsorSchema,AddressSchema} = require('./schemas.js')
const Schema = mongoose.Schema;



const RecordSchema = new Schema({
    application: { type: Schema.Types.ObjectId, ref: 'Application' },
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
    birthDate: Date,
    placeOfBirth: String,
    address: AddressSchema,
    health: {
        generalCondition: String,
        remark: String,
        history: [String]
    },
    currentEducation: EducationSchema,
    previousEducations: [EducationSchema],
    families: [FamilySchema],
    place: PlaceSchema,
    story: StorySchema,
    date: Date,
    status: String,
    processedBy: String,
    sponsor:SponsorSchema,
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
