var slots = require('../helpers/slots.js'),
	ed = require('ed25519'),
	crypto = require('crypto'),
	genesisblock = null,
	bignum = require('../helpers/bignum.js'),
	ByteBuffer = require("bytebuffer"),
	blockReward = require("../helpers/blockReward.js"),
	constants = require('../helpers/constants.js');

// Constructor
function Block(scope, cb) {
	this.scope = scope;
	genesisblock = this.scope.genesisblock;
	cb && setImmediate(cb, null, this);
}

// Private methods
var private = {};
private.blockReward = new blockReward();
private.getAddressByPublicKey = function (publicKey) {
	var publicKeyHash = crypto.createHash('sha256').update(publicKey, 'hex').digest();
	var temp = new Buffer(8);
	for (var i = 0; i < 8; i++) {
		temp[i] = publicKeyHash[7 - i];
	}

	var address = bignum.fromBuffer(temp).toString() + "L";
	return address;
}
private.getSecret = function(previousBlockId, keypair) {
    var privatekeyHash = crypto.createHash('sha256').update(keypair.privateKey.toString('hex')).digest();
    var secret = crypto.createHash('sha256').update(privatekeyHash).update(previousBlockId).digest();
    return secret.toString('hex');
}
private.getPreviousSecret = function(db, keypair) {
    var sql = "SELECT b.\"height\" FROM blocks b " +
    "WHERE ENCODE(\"generatorPublicKey\", 'hex') = ${generatorPublicKey} ORDER BY \"height\" DESC LIMIT 1" ;
    return db.query(sql, {generatorPublicKey:keypair.publicKey.toString('hex')}).then(function(rows){
        if (rows.length) {
            var sql = "SELECT b.\"id\" FROM blocks b where \"height\"=${height}" ;
            return db.query(sql, {height:rows[0].height-1}).then(function(rows) {
                return private.getSecret(rows[0].id, keypair);
            });
        } else {
            return '0000000000000000000000000000000000000000000000000000000000000000';
        }
    }.bind(this));
}
// Public methods
Block.prototype.create = function (data) {
	var transactions = data.transactions.sort(function compare(a, b) {
		if (a.type < b.type) return -1;
		if (a.type > b.type) return 1;
		if (a.amount < b.amount) return -1;
		if (a.amount > b.amount) return 1;
		return 0;
	})

	var nextHeight = (data.previousBlock) ? data.previousBlock.height + 1 : 1;

	var reward = private.blockReward.calcReward(nextHeight),
	    totalFee = 0, totalAmount = 0, size = 0;

	var blockTransactions = [];
	var payloadHash = crypto.createHash('sha256');

	for (var i = 0; i < transactions.length; i++) {
		var transaction = transactions[i];
		var bytes = this.scope.transaction.getBytes(transaction);

		if (size + bytes.length > constants.maxPayloadLength) {
			break;
		}

		size += bytes.length;

		totalFee += transaction.fee;
		totalAmount += transaction.amount;

		blockTransactions.push(transaction);
		payloadHash.update(bytes);
	}
	
	var block = {
        version: 0,
        totalAmount: totalAmount,
        totalFee: totalFee,
        reward: reward,
        payloadHash: payloadHash.digest().toString('hex'),
        timestamp: data.timestamp,
        numberOfTransactions: blockTransactions.length,
        payloadLength: size,
        previousBlock: data.previousBlock.id,
        generatorPublicKey: data.keypair.publicKey.toString('hex'),
        transactions: blockTransactions
    };

	return private.getPreviousSecret(this.scope.db, data.keypair).then(function(previousSecret){
	    var secretHash = private.getSecret(data.previousBlock.id, data.keypair);
	    secretHash = crypto.createHash('sha256').update(new Buffer(secretHash, 'hex')).digest().toString('hex');
	    block.previousSecret = previousSecret;
        block.secretHash = secretHash;

        block.blockSignature = this.sign(block, data.keypair);
        block = this.objectNormalize(block);
    return block;
	    
	}.bind(this))
}

Block.prototype.sign = function (block, keypair) {
	var hash = this.getHash(block);

	return ed.Sign(hash, keypair).toString('hex');
}

Block.prototype.getBytes = function (block) {
	var size = 4 + 4 + 8 + 4 + 4 + 8 + 8 + 4 + 4 + 4 + 32 + 32 + 64;

	try {
		var bb = new ByteBuffer(size, true);
		bb.writeInt(block.version);
		bb.writeInt(block.timestamp);

		if (block.previousBlock) {
			var pb = bignum(block.previousBlock).toBuffer({size: '8'});

			for (var i = 0; i < 8; i++) {
				bb.writeByte(pb[i]);
			}
		} else {
			for (var i = 0; i < 8; i++) {
				bb.writeByte(0);
			}
		}

		bb.writeInt(block.numberOfTransactions);
		bb.writeLong(block.totalAmount);
		bb.writeLong(block.totalFee);
		bb.writeLong(block.reward);
		var previousSecretBuffer = new Buffer(block.previousSecret, 'hex');
        for (var i = 0; i < previousSecretBuffer.length; i++) {
            bb.writeByte(previousSecretBuffer[i]);
        }
        var secretHashBuffer = new Buffer(block.secretHash, 'hex');
        for (var i = 0; i < secretHashBuffer.length; i++) {
            bb.writeByte(secretHashBuffer[i]);
        }

		bb.writeInt(block.payloadLength);

		var payloadHashBuffer = new Buffer(block.payloadHash, 'hex');
		for (var i = 0; i < payloadHashBuffer.length; i++) {
			bb.writeByte(payloadHashBuffer[i]);
		}

		var generatorPublicKeyBuffer = new Buffer(block.generatorPublicKey, 'hex');
		for (var i = 0; i < generatorPublicKeyBuffer.length; i++) {
			bb.writeByte(generatorPublicKeyBuffer[i]);
		}

		if (block.blockSignature) {
			var blockSignatureBuffer = new Buffer(block.blockSignature, 'hex');
			for (var i = 0; i < blockSignatureBuffer.length; i++) {
				bb.writeByte(blockSignatureBuffer[i]);
			}
		}

		bb.flip();
		var b = bb.toBuffer();
	} catch (e) {
		throw Error(e.toString());
	}

	return b;
}

Block.prototype.verifySignature = function (block) {
	var remove = 64;
	try {
		var data = this.getBytes(block);
		var data2 = new Buffer(data.length - remove);

		for (var i = 0; i < data2.length; i++) {
			data2[i] = data[i];
		}
		var hash = crypto.createHash('sha256').update(data2).digest();
		var blockSignatureBuffer = new Buffer(block.blockSignature, 'hex');
		var generatorPublicKeyBuffer = new Buffer(block.generatorPublicKey, 'hex');
		var res = ed.Verify(hash, blockSignatureBuffer || ' ', generatorPublicKeyBuffer || ' ');
	} catch (e) {
		throw Error(e.toString());
	}
    var sql = "SELECT ENCODE(b.\"secretHash\", 'hex') AS secret_hash FROM blocks b " +
    "WHERE ENCODE(\"generatorPublicKey\", 'hex') = ${generatorPublicKey} AND \"height\"<${height} ORDER BY \"height\" DESC LIMIT 1" ;
    return this.scope.db.query(sql, {generatorPublicKey:block.generatorPublicKey, height: block.height}).then(function(rows){
        if (rows.length) {
            if (rows[0].secret_hash!=crypto.createHash('sha256').update(new Buffer(block.previousSecret, 'hex')).digest().toString('hex')) {
                throw 'previousSecret '+block.previousSecret+' not matched with last secretHash ' + rows[0].secret_hash;
            };
        }
    }).then(function(){
	return res;
    });
}

Block.prototype.dbTable = "blocks";

Block.prototype.dbFields = [
	"id",
	"version",
	"timestamp",
	"height",
	"previousBlock",
	"numberOfTransactions",
	"totalAmount",
	"totalFee",
	"reward",
	"previousSecret",
	"secretHash",
	"payloadLength",
	"payloadHash",
	"generatorPublicKey",
	"blockSignature"
];

Block.prototype.dbSave = function (block) {
	try {
		var payloadHash = new Buffer(block.payloadHash, 'hex');
		var generatorPublicKey = new Buffer(block.generatorPublicKey, 'hex');
		var blockSignature = new Buffer(block.blockSignature, 'hex');
		var previousSecret = new Buffer(block.previousSecret, 'hex');
		var secretHash = new Buffer(block.secretHash, 'hex');
	} catch (e) {
		throw e.toString();
	}

	return {
		table: this.dbTable,
		fields: this.dbFields,
		values: {
			id: block.id,
			version: block.version,
			timestamp: block.timestamp,
			height: block.height,
			previousBlock: block.previousBlock || null,
			numberOfTransactions: block.numberOfTransactions,
			totalAmount: block.totalAmount,
			totalFee: block.totalFee,
			reward: block.reward || 0,
			previousSecret: previousSecret,
			secretHash: secretHash,
			payloadLength: block.payloadLength,
			payloadHash: payloadHash,
			generatorPublicKey: generatorPublicKey,
			blockSignature: blockSignature
		}
	};
}

Block.prototype.objectNormalize = function (block) {
	for (var i in block) {
		if (block[i] == null || typeof block[i] === 'undefined') {
			delete block[i];
		}
	}

	var report = this.scope.scheme.validate(block, {
		type: "object",
		properties: {
			id: {
				type: "string"
			},
			height: {
				type: "integer"
			},
			blockSignature: {
				type: "string",
				format: "signature"
			},
			generatorPublicKey: {
				type: "string",
				format: "publicKey"
			},
			numberOfTransactions: {
				type: "integer"
			},
			payloadHash: {
				type: "string",
				format: "hex"
			},
			payloadLength: {
				type: "integer"
			},
			previousBlock: {
				type: "string"
			},
			timestamp: {
				type: "integer"
			},
			totalAmount: {
				type: "integer",
				minimum: 0
			},
			totalFee: {
				type: "integer",
				minimum: 0
			},
			reward: {
				type: "integer",
				minimum: 0
			},
			previousSecret: {
			    type: "string",
                format: "hex"
			},
			secretHash: {
                type: "string",
                format: "hex"
            },
			transactions: {
				type: "array",
				uniqueItems: true
			},
			version: {
				type: "integer",
				minimum: 0
			}
		},
		required: ['blockSignature', 'generatorPublicKey', 'numberOfTransactions', 'payloadHash', 'payloadLength', 'timestamp', 'totalAmount', 'totalFee', 'reward', 'previousSecret', 'secretHash', 'transactions', 'version']
	});

	if (!report) {
		throw Error(this.scope.scheme.getLastError());
	}

	try {
		for (var i = 0; i < block.transactions.length; i++) {
			block.transactions[i] = this.scope.transaction.objectNormalize(block.transactions[i]);
		}
	} catch (e) {
		throw Error(e.toString());
	}

	return block;
}

Block.prototype.getId = function (block) {
	var hash = crypto.createHash('sha256').update(this.getBytes(block)).digest();
	var temp = new Buffer(8);
	for (var i = 0; i < 8; i++) {
		temp[i] = hash[7 - i];
	}

	var id = bignum.fromBuffer(temp).toString();
	return id;
}

Block.prototype.getHash = function (block) {
	return crypto.createHash('sha256').update(this.getBytes(block)).digest();
}

Block.prototype.calculateFee = function (block) {
	return 10000000;
}

Block.prototype.dbRead = function (raw) {
	if (!raw.b_id) {
		return null
	} else {
		var block = {
			id: raw.b_id,
			version: parseInt(raw.b_version),
			timestamp: parseInt(raw.b_timestamp),
			height: parseInt(raw.b_height),
			previousBlock: raw.b_previousBlock,
			numberOfTransactions: parseInt(raw.b_numberOfTransactions),
			totalAmount: parseInt(raw.b_totalAmount),
			totalFee: parseInt(raw.b_totalFee),
			reward: parseInt(raw.b_reward),
			previousSecret: raw.b_previousSecret,
			secretHash: raw.b_secretHash,
			payloadLength: parseInt(raw.b_payloadLength),
			payloadHash: raw.b_payloadHash,
			generatorPublicKey: raw.b_generatorPublicKey,
			generatorId: private.getAddressByPublicKey(raw.b_generatorPublicKey),
			blockSignature: raw.b_blockSignature,
			confirmations: parseInt(raw.b_confirmations)
		}
		block.totalForged = bignum(block.totalFee).plus(bignum(block.reward)).toString();
		return block;
	}
}

// Export
module.exports = Block;
