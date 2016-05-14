var ByteBuffer = require("bytebuffer");
var jsonSql = require('json-sql')();
var constants = require("../helpers/constants.js");
var crypto = require('crypto');
var ed = require('ed25519');
var async = require('async');

var private = {}, self = null,
    library = null, modules = null;
var Router = require('../helpers/router.js')

function Dice(cb, _library) {
    self = this;
    self.type = 6
    library = _library;
    library.logic.transaction.attachAssetType(self.type, self);
    private.attachApi();
    cb(null, self);
}

private.attachApi = function () {
    var router = new Router();

    router.use(function (req, res, next) {
        if (modules) return next();
        res.status(500).send({success: false, error: "Blockchain is loading"});
    });

    router.map(Dice.prototype, {
        "get /list": "list",
        "put /add": "add"
    });

    router.use(function (req, res, next) {
        res.status(500).send({success: false, error: "API endpoint not found"});
    });

    library.network.app.use('/api/dices', router);
    library.network.app.use(function (err, req, res, next) {
        if (!err) return next();
        library.logger.error(req.url, err);
        res.status(500).send({success: false, error: err.toString()});
    });
}

Dice.prototype.create = function (data, trs) {
    trs.recipientId = data.recipientId;
    trs.asset = {
        dice: data.dice
    };

    return trs;
}

Dice.prototype.calculateFee = function (trs) {
    return 100000000;
}

Dice.prototype.verify = function (trs, sender, cb, scope) {
    // if (trs.asset.dice.amount > 1000000*100000000) {
    //     return setImmediate(cb, "Max dice amount exceeded");
    // }

    setImmediate(cb, null, trs);
}

Dice.prototype.getBytes = function (trs) {
    var bb = new ByteBuffer(1+8+8, true);
    bb.writeLong(trs.asset.dice.amount);
    bb.writeLong(trs.asset.dice.payout);
    bb.writeByte(trs.asset.dice.rollHigh?1:0);
    bb.flip();
    return bb.toBuffer();
}

Dice.prototype.apply = function (trs, block, sender, cb) {
    modules.accounts.mergeAccountAndGet({
        address: sender.address,
        balance: - trs.asset.dice.amount
    }, cb);
}

Dice.prototype.undo = function (trs, block, sender, cb) {
    modules.accounts.undoMerging({
        address: sender.address,
        balance: trs.asset.dice.amount
    }, cb);
}

Dice.prototype.beforeDeleteBlock = function(block, cb){
    var sql = jsonSql.build({
        table: "trs",
        alias: "t",
        condition: {blockId: block.id},
        fields: ['id', 'type', 'senderId', 'senderPublicKey', 'recipientId', 't.timestamp', 't.amount', 'fee', 'signature', 'blockId', 'transactionId', {'td.amount':'td_amount'}, 'payout', 'rollHigh', 'luckyNumber', 'resolveBlockHeight', 'paidOut'],
        sort: {'timestamp':-1},
        join: [{
            type: 'inner',
            table: 'asset_dices',
            alias: "td",
            fields:['amount', 'payout', 'rollHigh', 'paidOut'],
            on: {"t.id": "td.transactionId"}
        }]
    });
    library.db.query(sql.query, sql.values).then(function(transactions){
        async.each(transactions,function(tx, cb) {
            if (tx.paidOut>0) {
                modules.accounts.mergeAccountAndGet({
                    address: tx.senderId,
                    balance: -tx.paidOut,
                    u_balance: -tx.paidOut
                }, cb);
            } else {
                cb();
            }
        }, cb);
    }).catch(cb);

}
Dice.prototype.afterBlockSaved = function(block, cb){
    //dispatch resolve height
    async.each(block.transactions, function(trs, cb) {
        if (trs.type!=6) return cb();
        var sql = jsonSql.build({
            type: 'update',
            table: "asset_dices",
            condition: {
                transactionId: trs.id
            },
            modifier:{
                resolveBlockHeight: block.height+1
            }
        });
        library.db.query(sql.query, sql.values).then(function(){
            cb();
        }).catch(cb);
    }, function(err) {
        if (err) return cb(err);
        //todo resolve all the dices targeted in this block.
        //lucky number from block hash

        var hex = new Buffer(block.blockSignature, 'hex');
        
        var luckyNumber = Math.floor((hex[0]*256+hex[1])*1000000/(256*256));
        var sql = jsonSql.build({
            type: 'update',
            table: "asset_dices",
            condition: {
                resolveBlockHeight: block.height
            },
            modifier:{
                luckyNumber: luckyNumber
            }
        });
        library.db.query(sql.query, sql.values).then(function(){
            var listSql = jsonSql.build({
                table: "trs",
                alias: "t",
                condition: {
                    type: self.type,
                    resolveBlockHeight: block.height
                },
                fields: ['id', 'type', 'senderId', 'senderPublicKey', 'recipientId', 't.amount', 'fee', 'signature', 'blockId', 'transactionId', {'td.amount':'td_amount'}, 'payout', 'rollHigh'],
                join: [{
                    type: 'left outer',
                    table: 'asset_dices',
                    alias: "td",
                    fields:['amount', 'payout', 'rollHigh'],
                    on: {"t.id": "td.transactionId"}
                }]
            });
    
            return library.db.query(listSql.query, listSql.values).then(function(transactions){
                async.each(transactions, function(trs, cb){
                    trs.payout = parseInt(trs.payout);
                    var times = (trs.payout/trs.td_amount);
                    var chanceToWin = 99/times;
                    var lowerThan = chanceToWin*10000;
                    var higherThan = (100- chanceToWin)*10000-1;
                    console.log('lucky>' + higherThan);
                    var win = (trs.rollHigh && luckyNumber > higherThan) || (!trs.rollHigh && luckyNumber < lowerThan);
                    var paidOut = win?trs.payout:0;
                        //win
                        modules.accounts.mergeAccountAndGet({
                            address: trs.senderId,
                            balance: paidOut,
                            u_balance: paidOut
                        }, function(e){
                            if (e) return cb(e);
                            var updateSql = jsonSql.build({
                                type: 'update',
                                table: "asset_dices",
                                condition: {
                                    transactionId: trs.id
                                },
                                modifier:{
                                    paidOut: paidOut
                                }
                            });
                            library.db.query(updateSql.query, updateSql.values).then(function(){
                                cb();
                            }).catch(cb);
                        });
                }, cb);
            });
        }).catch(cb);
    });
}

Dice.prototype.applyUnconfirmed = function (trs, sender, cb, scope) {
    if (sender.u_balance < trs.fee+ trs.asset.dice.amount) {
        return setImmediate(cb, "Sender doesn't have enough coins");
    }

    modules.accounts.mergeAccountAndGet({
        address: sender.address,
        u_balance: -trs.asset.dice.amount
    }, cb);
}

Dice.prototype.undoUnconfirmed = function (trs, sender, cb, scope) {
    library.logic.account.merge(sender.address, {
        u_balance: trs.asset.dice.amount
    }, function (err) {
        cb(err);
    });
}

Dice.prototype.ready = function (trs, sender) {
    return true;
}

Dice.prototype.dbSave = function (trs) {

    return {
        table: "asset_dices",
        fields: ['transactionId','amount', 'payout', 'rollHigh'],
        values: {
                    transactionId: trs.id,
                    amount: trs.asset.dice.amount,
                    payout: trs.asset.dice.payout,
                    rollHigh: trs.asset.dice.rollHigh?1:0,
                    paidOut: 0
                }
    };
}

Dice.prototype.dbRead = function (row) {
    if (!row.dice_amount) {
        return null;
    } else {
        return {
            dice: {
                amount: parseInt(row.dice_amount),
                payout: parseInt(row.dice_payout),
                rollHigh: row.dice_rollHigh
            }
        };
    }
}
Dice.prototype.process = function (trs, sender, cb) {
    setImmediate(cb, null, trs);
}

Dice.prototype.objectNormalize = function (trs) {
    console.log(trs.asset)
    var report = library.scheme.validate(trs.asset, {
        type: "object", // It is an object
        properties: {
            dice:{
                type:"object",
                properties: {
                    amount: {
                        type: "integer",
                        minimum: 0
                    },
                    payout: {
                        type: "integer",
                        minimum: 0
                    },
                    rollHigh: {
                         type: "integer"
                     }
                },
                required: ["amount", "payout", "rollHigh"]
            }
        },
        required: ["dice"] // Message property is required and must be defined
    });
    if (!report) {
        throw new Error("Incorrect dice in transactions: " + library.scheme.getLastError());
    }
    return trs;
}

Dice.prototype.onBind = function (_modules) {
    modules = _modules;
}

Dice.prototype.add = function (query1, cb) {
    var query = query1.body;
    library.scheme.validate(query, {
        type: "object",
        properties: {
            secret: {
                type: "string",
                minLength: 1,
                maxLength: 100
            },
            dice:{
                type:"object",
                properties: {
                    amount: {
                        type: "integer",
                        minimum: 0
                    },
                    payout: {
                        type: "integer",
                        minimum: 0
                    },
                     rollHigh: {
                           type: "integer"
                     },
                     resolveBlockHeight: {
                         type: "integer",
                         minimum: 0
                     },
                    luckyNumber: {
                       type: "integer",
                       minimum: 0
                   },
                   paidOut: {
                       type: "integer",
                       minimum: 0
                   }
                },
                required: ["amount", "payout", "rollHigh"]
            }
        }
    }, function (err) {
        // If error exists, execute callback with error as first argument
        if (err) {
            return cb(err[0].message);
        }
        
        var hash = crypto.createHash('sha256').update(query.secret, 'utf8').digest();
        var keypair = ed.MakeKeypair(hash);
        modules.accounts.getAccount({
            publicKey: keypair.publicKey.toString('hex')
        }, function (err, account) {
            // If error occurs, call cb with error argument
            if (err) {
                return cb(err);
            }
            var transaction;
            try {
                transaction = library.logic.transaction.create({
                    type: self.type,
                    dice: query.dice,
                    recipientId: account.address,
                    sender: account,
                    keypair: keypair
                });
                
                // Send transaction for processing
                modules.transactions.processUnconfirmedTransaction(transaction, true, function(e) {
                    if (e) return cb(e);
                    cb(e, {id:transaction.id});
                });
            } catch (e) {
                // Catch error if something goes wrong
                return setImmediate(cb, e);
            }
        });
    });
}

Dice.prototype.list = function (query1, cb) {
    var query = query1.body;
    // Verify query parameters
    library.scheme.validate(query, {
        type: "object",
        properties: {
            recipientId: {
                type: "string",
                minLength: 2,
                maxLength: 21
            }
        }
    }, function (err) {
        if (err) {
            return cb(err[0].message);
        }
        var condition = {
            type: self.type
        };
        if (query.address) {
            condition.senderId = query.address;
        }
        // Select from transactions table and join dices from the asset_dices table
        var sql = jsonSql.build({
            table: "trs",
            alias: "t",
            condition: condition,
            fields: ['id', 'type', 'senderId', 'senderPublicKey', 'recipientId', 't.timestamp', 't.amount', 'fee', 'signature', 'blockId', 'transactionId', {'td.amount':'td_amount'}, 'payout', 'rollHigh', 'luckyNumber', 'resolveBlockHeight', 'paidOut'],
            sort: {'timestamp':-1},
            limit: 100,
            join: [{
                type: 'left outer',
                table: 'asset_dices',
                alias: "td",
                fields:['amount', 'payout', 'rollHigh'],
                on: {"t.id": "td.transactionId"}
            }]
        });
        library.db.query(sql.query, sql.values).then(function(transactions){
            
            // Map results to asset object
            var dices = transactions.map(function (tx) {
                tx.asset = {
                    dice: {
                        amount: tx.td_amount, 
                        payout: tx.payout,
                        rollHigh: tx.rollHigh,
                        luckyNumber: tx.luckyNumber,
                        resolveBlockHeight: tx.resolveBlockHeight,
                        paidOut: tx.paidOut==undefined?tx.paidOut:parseInt(tx.paidOut)
                    }
                };

                delete tx.td_amount;
                delete tx.payout;
                delete tx.rollHigh;
                delete tx.luckyNumber;
                delete tx.resolveBlockHeight;
                delete tx.paidOut;

                return tx;
            });

            return cb(null, {
                dices: dices
            })
        }).catch(cb);
    
    });
}


module.exports = Dice;