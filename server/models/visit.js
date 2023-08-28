

const mongoose = require('mongoose');
const {ExpenseSchema, OtherIncomeSchema,FamilyIncomeSchema, AssetSchema} = require('./visitSchemas.js')
const {EducationSchema, FamilySchema,StorySchema,PlaceSchema, SponsorSchema,AddressSchema,FileSchema} = require('./schemas.js')
const Schema = mongoose.Schema;
const moment = require('moment')
const VisitSchema = new Schema({
    homeId: String,
    takenBy: [{
        name: String
    }],
    date: {
        type: Date,
        index: true
    },
    addressChange: Boolean,
    address: AddressSchema,

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
    place: PlaceSchema,
    story:StorySchema,
    record: { type: Schema.Types.ObjectId, ref: 'Record' }, //benefitiaries // childrens
    registrationId: {
        type:String,
        unique:true
    },
    families: [FamilySchema],
    expense: ExpenseSchema,
    income: {
        familyIncomes:[FamilyIncomeSchema],333333
        otherIncomes: [OtherIncomeSchema]
    },
    asset: {
        commonAssets:[String],
        otherAssets:[AssetSchema]
    },
    livingCondition: {
        utilities:[String],
        remark:String,
        photos:[String]
    },
    result: {
        estimatedExpense: Number,
        necessaryExpense: Number,
        estimatedIncome: Number,
        trueIncome: Number,
        expenseRemark : String,
        incomeRemark: String,
        incomeEdited: Boolean,
        expenseEdited: Boolean,
        finadoFund: Number,
        totalIncome: Number,
        remainingIncome: Number,
        remainingRemark: Number,

    },
    category: String,
    motivation: String,
    visitPhotos: [FileSchema],
    createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
    modifiedBy: { type: Schema.Types.ObjectId, ref: 'User' },

},{timestamps: true})

VisitSchema.virtual('age').get(function (){
    return moment(this.date).diff(moment(this.birthDate),'years') || -1
})

VisitSchema.virtual('fullName').
get(function() { return `${this.name||''} ${this.fatherName||''} ${this.gFatherName||''}`; }).
set(function(v) {
    // `v` is the value being set, so use the value to set
    // `firstName` and `lastName`.
    const name = v.substring(0, v.indexOf(' '));
    const fatherName = v.substring(v.indexOf(' ') + 1);
    const gFatherName = v.substring(v.indexOf(' ') + 2);
    this.set({ name, fatherName, gFatherName });
});
module.exports = mongoose.model('Visit', VisitSchema);
