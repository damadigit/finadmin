const mongoose = require('mongoose');
const Schema = mongoose.Schema;
const AddressSchema =  new Schema({
    phones: [{
        phoneType:String,
        number:String
    }],
    email: String,
    city: String,
    subcity:String,
    woreda: String,
    houseNumber: String,
    locationText: String,
    gps:{
        latitude: String,
        longitude: String,
    },
    photo:String,
    remark: String
})
const EducationSchema = new Schema({
    level: String,
    schoolName: String,
    schoolType: String,
    isDistance: Boolean,
    grade: Number,
    yearStart: Number,
    yearEnd: Number,
    active: Boolean,
    distance: Number,
    fee: Number

});


const FamilySchema = new Schema({
    relationship: String,
    name: String,
    fatherName: String,
    gFatherName: String,
    gender: String,
    birthDate: Date,
    health: {
        generalCondition: String,
        remark: String,
        history: [String]
    },
    photo: String,
    profession: String,
    workPlace: String,
    isIncomeProvider: Boolean,
    monthlyIncome: Number,
    currentEducation: EducationSchema,
    livingTogether: Boolean,
    notAlive: Boolean,
    address: AddressSchema,



})


const SponsorSchema = new Schema({
    name: String,
    fatherName: String,
    gFatherName: String,
    gender: String,
    address: AddressSchema


})

const FileSchema = new Schema({
    filePath: String,
    title: String,
    date: Date,
    description: String

})


const PlaceSchema = new Schema ({
    type: String,
    name: String,
    monthlyCost: Number,
    address: AddressSchema,
    numberOfPeople: String,
    livingConditions: [{
        name: String,
        available: Boolean
    }],
    photo: String,
    remark: String,

})

const StorySchema = new Schema ( {
    story: String,
    dream: String,
    hobby: String,
    governmentApproved: Boolean,
    photos: [FileSchema],
    files: [FileSchema]

})




module.exports = {EducationSchema, FamilySchema,PlaceSchema,AddressSchema,StorySchema,SponsorSchema, FileSchema}
