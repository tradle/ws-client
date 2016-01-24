
var EventEmitter = require('events').EventEmitter
var parseURL = require('url').parse
var util = require('util')
var Q = require('q')
var debug = require('debug')('websocket-client')
var typeforce = require('typeforce')
var io = require('socket.io-client')
var constants = require('@tradle/constants')
var OTR = require('@tradle/otr').OTR
var ROOT_HASH = constants.ROOT_HASH
var MSG_ENCODING = 'base64'
var MSG_CONTENT_TYPE = 'String'
// var HANDSHAKE_TIMEOUT = 5000

function Client (opts) {
  var self = this

  typeforce({
    url: 'String',
    otrKey: 'DSA',
    // byRootHash: 'Function',
    autoconnect: '?Boolean', // defaults to true
    rootHash: '?String'
  }, opts)

  EventEmitter.call(this)

  this._url = parseURL(opts.url)
  this._autoconnect = opts.autoconnect !== false
  // this._myIdentifier = {}
  // this._myIdentifier[ROOT_HASH] = this._rootHash
  // this._lookup = opts.byRootHash
  this._onmessage = this._onmessage.bind(this)
  this._sessions = {}
  this._otrKey = opts.otrKey
  this._connected = false
  if (opts.rootHash) this.setRootHash(opts.rootHash)
}

util.inherits(Client, EventEmitter)
module.exports = Client

Client.prototype.connect = function (reconnect) {
  var self = this

  if (!this._rootHash) throw new Error('set "rootHash" first')
  if (this._socket) {
    return this._promiseConnected()
  }

  var base = this._url.protocol + '//' + this._url.host
  this._socket = io.connect(base, { reconnection: reconnect, path: this._url.path })
  this._socket.emit('subscribe', this._rootHash)
  this._socket.on('error', function (err) {
    debug('socket experienced error', err)
    self._socket.disconnect()
  })

  // TODO: implement handshake
  if (false) {
    return this._handshake()
  } else {
    this._socket.on('message', this._onmessage)
    this._socket.on('disconnect', function () {
      self._connected = false
    })

    this._socket.on('connect', function () {
      self._connected = true
      self.emit('connect')
      debug('connected')
    })

    return this._promiseConnected()
  }
}

Client.prototype._promiseConnected = function () {
  if (this._connected) return Q()

  var defer = Q.defer()
  this.once('connect', defer.resolve)
  return defer.promise
}



Client.prototype.isConnected = function () {
  return this._connected
}

Client.prototype.setRootHash = function (rootHash) {
  typeforce('String', rootHash)
  this._rootHash = rootHash
  if (!this._socket && this._autoconnect) this.connect(true)

  return this
}

Client.prototype._onmessage = function (msg, acknowledgeReceipt) {
  acknowledgeReceipt()

  try {
    typeforce({
      from: 'String',
      message: MSG_CONTENT_TYPE
    }, msg)
  } catch (err) {
    debug('received invalid message missing "from"')
    return
  }

  if (!this._sessions[msg.from]) {
    this._createSession(msg.from)
  }

  this._sessions[msg.from].otr.receiveMsg(msg.message)
  // this.emit('message', msg.message, identityInfo)
}

// Client.prototype._handshake = function () {
//   var self = this

//   socket.on('disconnect', function () {
//     delete self._sockets[rootHash]
//   })

//   socket.on('error', function (err) {
//     debug('socket for', clientRootHash, 'experienced error', err)
//     socket.disconnect()
//   })

//   debug('initiating handshake with', rootHash)

//   var defer = Q.defer()
//   var lookup = this._lookup(rootHash)

//   socket.once('welcome', function () {
//     debug('handshake 3. complete')
//     delete self._pendingHanshakes[rootHash]
//     self._sockets[rootHash] = socket
//     defer.resolve()
//   })

//   socket.on('message', function (msg, cb) {
//     if (self._sockets[rootHash] !== socket) return

//     debug('received message from', rootHash)
//     lookup.then(function (identityInfo) {
//       self.emit('message', msg, identityInfo)
//       if (cb) cb() // acknowledgement
//     })
//   })

//   socket.once('disconnect', defer.reject)

//   this._pendingHanshakes[rootHash] = {
//     promise: defer.promise,
//     socket: socket
//   }

//   socket.once('handshake', function (challenge) {
//     self._onhandshake(rootHash, socket, challenge)
//   })

//   socket.emit('join', this._myIdentifier)

//   return defer.promise
// }

// Client.prototype._onhandshake = function (rootHash, socket, challenge) {
//   var self = this

//   debug('handshake 1. received challenge')
//   var fingerprint = challenge.key
//   var priv = this._keys.filter(function (k) {
//     return k.fingerprint() === fingerprint
//   })[0]

//   if (!priv) return Q.reject(new Error('key not found'))

//   Q.ninvoke(utils, 'newMsgNonce')
//     .then(function (nonce) {
//       challenge.clientNonce = nonce
//       return Q.ninvoke(priv, 'sign', utils.stringify(challenge))
//     })
//     .then(function (sig) {
//       challenge[SIG] = sig
//       socket.emit('handshake', challenge)
//       debug('handshake 2. sending challenge response')
//     })
//     .catch(function (err) {
//       debug('experienced handshake error', err)
//       socket.disconnect()
//     })
// }

// Client.prototype.addEndpoint =
// Client.prototype.addRecipient = function (rootHash, url) {
//   typeforce('String', rootHash)
//   typeforce('String', url)
//   this._recipients[rootHash] = url
// }

Client.prototype.send = function (rootHash, msg, identityInfo) {
  var self = this
  if (!this._socket) {
    return this.connect()
      .then(function () {
        return self.send(rootHash, msg, identityInfo)
      })
  }

  if (Buffer.isBuffer(msg)) msg = msg.toString(MSG_ENCODING)

  if (!this._sessions[rootHash]) {
    this._createSession(rootHash)
  }

  var defer = Q.defer()
  var session = this._sessions[rootHash]
  var deliveryTrackers = session.deliveryTrackers
  session.otr.sendMsg(msg.toString(MSG_ENCODING), function () {
    // we just sent the last piece of this message
    // replace the placeholder we pushed
    // yes, this is ugly
    deliveryTrackers[deliveryTrackers.length - 1] = defer.resolve
  })

  return defer.promise
}

Client.prototype._createSession = function (recipientRootHash) {
  var self = this
  var deliveryTrackers = []
  var otr = new OTR({
    priv: this._otrKey
  })

  var session = this._sessions[recipientRootHash] = {
    otr: otr,
    deliveryTrackers: deliveryTrackers
  }

  otr.ALLOW_V2 = false
  otr.REQUIRE_ENCRYPTION = true
  otr.on('ui', function (msg) {
    var senderInfo = {}
    senderInfo[ROOT_HASH] = recipientRootHash
    self.emit('message', new Buffer(msg, MSG_ENCODING), senderInfo)
  })

  otr.on('io', function (msg, metadata) {
    deliveryTrackers.push(null) // placeholder
    self._socket.emit('message', {
      from: self._rootHash,
      to: recipientRootHash,
      message: msg
    }, function acknowledgement () {
      var cb = deliveryTrackers.shift()
      if (cb) cb()
    })
  })

  otr.on('error', function (err) {
    debug('otr err', err)
    self._destroySession(recipientRootHash)
  })
}

// Client.prototype._sendOTR = function (session, msg, metadata) {
//   var self = this

//   if (!this._socket) {
//     session.queued.push(arguments)
//     this.once('connect', function () {
//       var queued = session.queued.slice()
//       session.queued.length = 0
//       queued.forEach(function (args) {
//         self._sendOTR.apply(self, args)
//       })
//     })

//     return
//   }

//   session.deliveryTrackers.push(null) // placeholder
//   this._socket.emit('message', {
//     from: this._rootHash,
//     to: session.recipient,
//     message: msg
//   }, function acknowledgement () {
//     var cb = session.deliveryTrackers.shift()
//     if (cb) cb()
//   })
// }

Client.prototype._destroySession = function (rootHash) {
  var self = this
  var session = this._sessions[rootHash]
  if (!session) return Q()

  return Q.ninvoke(session.otr, 'endOtr')
    .finally(function () {
      delete self._sessions[rootHash]
    })
}

Client.prototype.destroy = function () {
  var self = this
  if (this._destroyed) return Q.reject(new Error('already destroyed'))

  debug('destroying')
  this._destroyed = true
  return Q.all(Object.keys(this._sessions).map(this._destroySession, this))
    .then(function () {
      self._socket.disconnect()
      delete self._sessions
    })
}
