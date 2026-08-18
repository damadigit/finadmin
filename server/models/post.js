const mongoose = require('mongoose');
const Schema = mongoose.Schema;
const moment = require('moment')
const {FileSchema} = require("./schemas");
const PostSchema = new Schema({
    date: {
        type: Date,
        default: new Date(),
        index: true
    },
    recordId: { type: Schema.Types.ObjectId, ref: 'Record' },
    body: String,
    title: {
        type: String,
        index: true
    },
    type:String,
    files: [FileSchema]


})

module.exports = mongoose.model('Post', PostSchema);
