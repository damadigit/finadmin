
const axios = require('axios')
const docx = require('docx');
const moment = require('moment')
const { convert } = require('html-to-text');
const { Document, Packer, Paragraph, Table, TableCell, TableRow, TextRun, ImageRun } = docx;
const categories = {A:"Can Manage without finado fund", B:"Can Manage only with finado fund", C:"Can't Manage even with finado fund"}
const utilities =[
    { id: 'PrivateSanitary', name: 'Private Sanitary' },
    { id: 'PublicSanitary', name: 'Public Sanitary' },
    { id: 'PublicWater', name: 'Public Water' },
    { id: 'TapWater', name: 'Tap Water' },
    { id: 'Electric', name: 'Electric City' },
]

const assets = [
    { id: 'Furniture', name: 'Furniture' },
    { id: 'Tv', name: 'TV' },
    { id: 'Refrigerator', name: 'Refrigerator' },
]
const convertOptions = {
    wordwrap: 130,
    // ...
};

function getHeader(text, size=30) {
    return     new TableRow({

        children: [
            new TableCell({
                columnSpan:6,
                children: [new Paragraph({
                    children:[
                        new TextRun({
                            text,
                            bold:true,
                            size,
                        })
                    ]
                })],
            }),

        ],
    })
}

const getVisitWord =  async ({visit}) => {


    const photo = visit.photo && await axios.get(visit.photo, {
        responseType: 'arraybuffer'  /* or responseType: 'arraybuffer'  */
    }).then(response => Buffer.from(response.data, 'binary').toString('base64'))

    const place = visit.place.photo && await axios.get(visit.place.photo, {
        responseType: 'arraybuffer'  /* or responseType: 'arraybuffer'  */
    }).then(response => Buffer.from(response.data, 'binary').toString('base64'))

    // console.log(blob)




    const table = new Table({
        rows: [
            new TableRow({
                children: [
                    new TableCell({
                        columnSpan:3,
                        children: [new Paragraph("Visit By: "+ (visit.takenBy && visit.takenBy.map(m=>m.name).join(','))||'')],
                    }),
                    new TableCell({
                        columnSpan:3,
                        children: [new Paragraph("Date Taken: "+visit.date?moment(visit.date).format('MMMM DD, YYYY'):'')],
                    }),
                ],
            }),
            getHeader('Beneficiary Detail'),
            new TableRow({
                children: [
                    new TableCell({
                        columnSpan:3,
                        children: [
                            new Paragraph({
                                children: [

                                    new TextRun({
                                        text: visit.fullName||'',
                                        bold: true,
                                        size: 52,
                                    }),

                                ],
                            }),
                            new Paragraph({
                                children: [

                                    new TextRun({
                                        text: "Finado Code "

                                    }),
                                    new TextRun({
                                        text: visit.registrationId||'',
                                        size: 40,
                                        bold: true
                                    }),
                                ],
                            }),

                            new Paragraph({
                                    children:[
                                        new TextRun(`${visit.gender||''}, Age`),
                                        new TextRun({
                                            text: visit.age + ' ',
                                            bold:true
                                        }),
                                        new TextRun(`when visit is taken`),


                                    ]
                                }
                            ),
                            new Paragraph(""),

                            new Paragraph({
                                    children:[
                                        new TextRun("Birth Date: "),
                                        new TextRun({
                                            text:moment(visit.birthDate).format("MMMM DD, YYYY"),
                                            bold:true
                                        }),
                                        new TextRun(`(now ${moment(new Date()).diff(moment(visit.birthDate), 'years')} years old)`),
                                    ]
                                }
                            )


                        ],
                    }),
                    new TableCell({
                        columnSpan:3,
                        children: [new Paragraph({
                            children: [
                                new ImageRun({
                                    data:  Uint8Array.from(atob(photo), c =>
                                        c.charCodeAt(0)
                                    ),
                                    transformation: {
                                        width: 300,
                                        height: 400
                                    }
                                })
                            ]
                        })],
                    }),
                ],
            }),
            getHeader('Address'),
            visit.place && visit.place.address && new TableRow({

                children: [
                    new TableCell({
                        columnSpan:2,
                        children:[new Paragraph(visit.place.address.locationText||'')]
                    }),
                    new TableCell({
                        columnSpan:2,
                        children:[
                            new Paragraph("Subcity: "+visit.place.address.subcity||''),
                            new Paragraph("Woreda: "+visit.place.address.woreda||'')

                        ],

                    }),
                    new TableCell({
                        columnSpan:2,
                        children:[
                            new Paragraph("Phone: "+(visit.address&& visit.address.phones[0]&& visit.address.phones[0].number)||''),

                        ],

                    }),


                ],
            }),
            getHeader('Family Detail'),
            new TableRow({

                children: [
                    new TableCell({
                        children:[new Paragraph("Name")]
                    }),
                    new TableCell({
                        children:[new Paragraph("Relation ")]
                    }),
                    new TableCell({
                        children:[new Paragraph("Age")]
                    }),
                    new TableCell({
                        children:[new Paragraph("Is Income Provider")]
                    }),
                    new TableCell({
                        children:[new Paragraph("Is Finado Contact")]
                    }),
                    new TableCell({
                        children:[new Paragraph("Phone")]
                    }),

                ],
            }),
            ...visit.families.map(f=>
                new TableRow({

                    children: [
                        new TableCell({
                            children:[new Paragraph((f.name + f.fatherName)||'')]
                        }),
                        new TableCell({
                            children:[new Paragraph(f.relationship||'')]
                        }),
                        new TableCell({
                            children:[new Paragraph((moment(new Date()).diff(moment(f.birthDate),'years'))||'')]
                        }),
                        new TableCell({
                            children:[new Paragraph(f.isIncomeProvider?'Yes':'No')]
                        }),
                        new TableCell({
                            children:[new Paragraph(f.isFinadoContact?'Yes':'')]
                        }),
                        new TableCell({
                            children:[new Paragraph((f.address&&f.address.phones[0].number)||'')]
                        }),

                    ],
                }),
            ),
            new TableRow({

                children: [
                    new TableCell({
                        columnSpan:6,
                        children: [new Paragraph({
                            children:[
                                new TextRun({
                                    text:"Parents/Guardian Information",
                                    bold:true,
                                    size:30
                                })
                            ]
                        })],
                    }),

                ],
            }),





            getHeader('Family Status'),
            new TableRow({

                children: [
                    new TableCell({
                        columnSpan:3,
                        children:[new  Paragraph("Total Number of people living in the house")]
                    }),
                    new TableCell({
                        columnSpan:3,
                        children:[new  Paragraph((visit.place && visit.place.numberOfPeople)||'')]
                    }),



                ],
            }),
            new TableRow({

                children: [
                    new TableCell({
                        columnSpan:3,
                        children:[new Paragraph("Finado’s Children")]
                    }),
                    new TableCell({
                        columnSpan:3,
                        children:[new  Paragraph('')]
                    }),



                ],
            }),
            new TableRow({

                children: [
                    new TableCell({
                        columnSpan:3,
                        children:[new Paragraph("Children who are not in Finado Program: ")]
                    }),
                    new TableCell({
                        columnSpan:3,
                        children:[new  Paragraph("")]
                    }),



                ],
            }),
            getHeader('Living Conditions'),
            new TableRow({

                children:[
                    new TableCell({
                        columnSpan:3,
                        rowSpan:10,
                        children: [
                            new Paragraph({
                                children: [
                                    new ImageRun({
                                        data:  Uint8Array.from(atob(place), c =>
                                            c.charCodeAt(0)
                                        ),
                                        transformation: {
                                            width: 200,
                                            height: 250
                                        }
                                    })
                                ]
                            }),
                            new Paragraph({
                                children:[
                                    new TextRun("House "),
                                    new TextRun({
                                        text:"Owned ",
                                        bold: true
                                    }),
                                    new TextRun("around"),
                                    new TextRun((visit.place && visit.place.address.locationText)||''),
                                ]
                            })


                        ],

                    }),
                    new TableCell({
                        columnSpan:3,
                        children:[
                            new Paragraph({
                                children:[new TextRun({
                                    text:"Essential Services",
                                    bold: true
                                })]
                            }),

                        ]
                    })
                ]
            }),
            ...utilities.map(c=>   new TableRow({
                children: [
                    new TableCell({
                        columnSpan:2,
                        children:[
                            new Paragraph(c.name||'')
                        ]
                    }),
                    new TableCell({
                        children:[
                            new Paragraph(visit.livingCondition.utilities.includes(c.id)?'✔ Yes':'✗ No')
                        ]
                    })
                ]
            })),

            new TableRow({

                children:[

                    new TableCell({
                    columnSpan:3,
                    children:[
                        new Paragraph({
                            children:[new TextRun({
                                text:"Assets",
                                bold: true
                            })]
                        }),

                    ]
                })

                ] }),

            ...assets.map(c=>   new TableRow({
                children: [
                    new TableCell({
                        columnSpan:2,
                        children:[
                            new Paragraph(c.name||'')
                        ]
                    }),
                    new TableCell({
                        children:[
                            new Paragraph((visit.asset&&visit.asset.commonAssets.includes(c.id)?'✔ Yes':'✗ No')||'')
                        ]
                    })
                ]
            })),

            getHeader("Visit Assessment"),
            new TableRow({

                children:[
                    new TableCell({

                        children:[
                            new Paragraph(" ")
                        ]
                    }),
                    new TableCell({

                        children:[
                            new Paragraph("Calculated")
                        ]
                    }),
                    new TableCell({

                        children:[
                            new Paragraph("Estimated by Visitor")
                        ]
                    }),
                    new TableCell({

                        children:[
                            new Paragraph("Value Taken")
                        ]
                    }),
                    new TableCell({
                        shading:{
                            color:"#ffa200",
                            fill:"#ffa200",
                        },

                        columnSpan:2,
                        rowSpan:6,
                        children:[
                            new Paragraph({
                                children:[
                                    new TextRun({
                                        color:"#FFFFFF",
                                        bold:true,
                                        size:52,
                                        text: "Class "+visit.category
                                    })
                                ]
                            }),
                            new Paragraph({
                                children:[
                                    new TextRun({
                                        text: categories[visit.category] || ''
                                    })
                                ]
                            })
                        ]
                    })
                ],
            }),
            new TableRow({
                children:[
                    new TableCell({
                        children: [
                            new Paragraph("Expense")
                        ]
                    }),
                    new TableCell({
                        children: [
                            new Paragraph("1880")
                        ]
                    }),
                    new TableCell({
                        children: [
                            new Paragraph("1880")
                        ]
                    }),
                    new TableCell({
                        children: [
                            new Paragraph("1880")
                        ]
                    })
                ]
            }),
            new TableRow({
                children:[
                    new TableCell({
                        children: [
                            new Paragraph("Income")
                        ]
                    }),
                    new TableCell({
                        children: [
                            new Paragraph("1880")
                        ]
                    }),
                    new TableCell({
                        children: [
                            new Paragraph("1880")
                        ]
                    }),
                    new TableCell({
                        children: [
                            new Paragraph("1880")
                        ]
                    })
                ]
            }),
            new TableRow({
                children:[
                    new TableCell({
                        children: [
                            new Paragraph("Fiando Fund")
                        ]
                    }),
                    new TableCell({
                        children: [
                            new Paragraph("")
                        ]
                    }),
                    new TableCell({
                        children: [
                            new Paragraph("")
                        ]
                    }),
                    new TableCell({
                        children: [
                            new Paragraph("1800")
                        ]
                    })
                ]
            }),
            new TableRow({
                children:[
                    new TableCell({
                        children: [
                            new Paragraph("Total Income")
                        ]
                    }),
                    new TableCell({
                        children: [
                            new Paragraph("")
                        ]
                    }),
                    new TableCell({
                        children: [
                            new Paragraph("")
                        ]
                    }),
                    new TableCell({
                        children: [
                            new Paragraph("4300")
                        ]
                    })
                ]
            }),
            new TableRow({
                children:[
                    new TableCell({
                        children: [
                            new Paragraph({
                                children:[
                                    new TextRun({
                                        text:"Remaining Income",
                                        bold:true
                                    })
                                ]
                            })
                        ]
                    }),
                    new TableCell({
                        children: [
                            new Paragraph("")
                        ]
                    }),
                    new TableCell({
                        children: [
                            new Paragraph("")
                        ]
                    }),
                    new TableCell({
                        children: [
                            new Paragraph({
                                children:[
                                    new TextRun({
                                        text:"2400",
                                        bold:true
                                    })
                                ]
                            })
                        ]
                    }),
                ]
            }),
            getHeader("Motivation of the ranking (apart from the above results )"),
            new TableRow({

                children: [
                    new TableCell({
                        margins:{
                            bottom:500,
                            top: 500
                        },
                        columnSpan:6,
                        children: [new Paragraph({
                            children:[
                                new TextRun({
                                    text: convert(visit.motivation || '', convertOptions),
                                    bold:true,
                                    size:26,
                                })
                            ]
                        })],
                    }),

                ],
            }),





            getHeader("Monthly Expenses"),
            getHeader('School Fee'),
            new TableRow({
                children:[
                    new TableCell({
                        columnSpan:2,
                        children:[new Paragraph("Name of child ")]
                    }),
                    new TableCell({

                        children:[new Paragraph("School ")]
                    }),
                    new TableCell({

                        children:[new Paragraph("School Type ")]
                    }),
                    new TableCell({
                        children:[new Paragraph("Grade/Level")]
                    }),
                    new TableCell({
                        children:[new Paragraph("Monthly Fee")]
                    })
                ]
            }),
            new TableRow({
                children:[
                    new TableCell({
                        columnSpan:2,
                        children:[new Paragraph("Name of child ")]
                    }),
                    new TableCell({

                        children:[new Paragraph("School ")]
                    }),
                    new TableCell({

                        children:[new Paragraph("School Type ")]
                    }),
                    new TableCell({
                        children:[new Paragraph("Grade/Level")]
                    }),
                    new TableCell({
                        children:[new Paragraph("Monthly Fee")]
                    })
                ]
            }),
            getHeader('Rent'),
            new TableRow({

                children: [
                    new TableCell({
                        columnSpan:5,
                        children: [new Paragraph({
                            children:[
                                new TextRun({
                                    text:"House Type",
                                    bold:true,

                                })
                            ]
                        })],
                    }),
                    new TableCell({
                        columnSpan:1,
                        children: [new Paragraph({
                            children:[
                                new TextRun({
                                    text:"Monthly Fee",
                                    bold:true,

                                })
                            ]
                        })],
                    }),

                ],
            }),
            new TableRow({

                children: [
                    new TableCell({
                        columnSpan:5,
                        children: [new Paragraph({
                            children:[
                                new TextRun({
                                    text:"Rental",
                                    bold:true,

                                })
                            ]
                        })],
                    }),
                    new TableCell({
                        columnSpan:1,
                        children: [new Paragraph({
                            children:[
                                new TextRun({
                                    text:"2300",
                                    bold:true,

                                })
                            ]
                        })],
                    }),

                ],
            }),
            getHeader('Groceries'),
            new TableRow({
                children:[
                    new TableCell({
                        columnSpan:2,
                        children:[
                            new Paragraph('Grocery Item')
                        ]
                    }),
                    new TableCell({
                        children:[
                            new Paragraph('Monthly Usage')
                        ]
                    }),
                    new TableCell({
                        children:[
                            new Paragraph('Unit Price')
                        ]
                    }),
                    new TableCell({
                        columnSpan:2,
                        children:[
                            new Paragraph('Monthly Cost')
                        ]
                    })
                ]
            }),
            new TableRow({
                children:[
                    new TableCell({
                        columnSpan:2,
                        children:[
                            new Paragraph('Grocery Item')
                        ]
                    }),
                    new TableCell({
                        children:[
                            new Paragraph('Usage')
                        ]
                    }),
                    new TableCell({
                        children:[
                            new Paragraph('Unit Price')
                        ]
                    }),
                    new TableCell({
                        columnSpan:2,
                        children:[
                            new Paragraph('Cost')
                        ]
                    })
                ]
            }),
            getHeader('Medical Expense'),
            new TableRow({
                children:[
                    new TableCell({
                        columnSpan:2,
                        children:[
                            new Paragraph('Patient Name')
                        ]
                    }),
                    new TableCell({
                        children:[
                            new Paragraph('Patient Relationship')
                        ]
                    }),
                    new TableCell({
                        columnSpan:2,
                        children:[
                            new Paragraph('Medical Condition')
                        ]
                    }),
                    new TableCell({

                        children:[
                            new Paragraph('Monthly Cost')
                        ]
                    })
                ]
            }),
            getHeader('Other Expenses'),
            new TableRow({
                children:[
                    new TableCell({
                        columnSpan:4,
                        children:[
                            new Paragraph('Description')
                        ]
                    }),
                    new TableCell({
                        children:[
                            new Paragraph('Expense Urgency (High, Low, Medium) ')
                        ]
                    }),

                    new TableCell({

                        children:[
                            new Paragraph('Monthly Cost')
                        ]
                    })
                ]
            }),
            getHeader("Income from Family Members"),
            new TableRow({
                children:[
                    new TableCell({
                        columnSpan:2,
                        children:[
                            new Paragraph('Family Member Name')
                        ]
                    }),
                    new TableCell({
                        children:[
                            new Paragraph('Relationship')
                        ]
                    }),
                    new TableCell({
                        children:[
                            new Paragraph('Occupation')
                        ]
                    }),
                    new TableCell({

                        children:[
                            new Paragraph('Employer')
                        ]
                    }),
                    new TableCell({

                        children:[
                            new Paragraph('Monthly Income ')
                        ]
                    })
                ]
            }),
            getHeader('Other Means Of Income'),
            new TableRow({
                children:[
                    new TableCell({
                        columnSpan:2,
                        children:[
                            new Paragraph('Source of income')
                        ]
                    }),
                    new TableCell({
                        children:[
                            new Paragraph('Frequency')
                        ]
                    }),
                    new TableCell({
                        columnSpan:2,
                        children:[
                            new Paragraph('Remark')
                        ]
                    }),

                    new TableCell({

                        children:[
                            new Paragraph('Monthly Income ')
                        ]
                    })
                ]
            }),
            getHeader("attitude questions"),
            new TableRow({
                children:[
                    new TableCell({
                        columnSpan:3,
                        children:[new Paragraph("Question /observation \n" +
                            "Remark \n")]
                    }),
                    new TableCell({
                        columnSpan:3,
                        children:[new Paragraph("0 -10 Scale   (0 pessimist view  --   10 optimist view Question /observation")]
                    })
                ]
            })
        ],
    });

    const doc = new Document({
        sections: [{
            children: [table],
        }],
    });

    return  Packer.toBase64String(doc);
}

module.exports = {getVisitWord}
