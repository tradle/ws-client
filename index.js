
var EventEmitter = require('events').EventEmitter
var parseURL = require('url').parse
var util = require('util')
var backoff = require('backoff')
var Q = require('q')
var debug = require('debug')('websocket-client')
var typeforce = require('typeforce')
var io = require('socket.io-client')
var constants = require('@tradle/constants')
var OTR = require('@tradle/otr').OTR
var ROOT_HASH = constants.ROOT_HASH
var MSG_ENCODING = 'base64'
var MSG_CONTENT_TYPE = 'String'
var SESSION_TIMEOUT = 5000
// var HANDSHAKE_TIMEOUT = 5000

function Client (opts) {
  var self = this

  typeforce({
    url: 'String',
    otrKey: 'DSA',
    // byRootHash: 'Function',
    instanceTag: '?String',
    autoconnect: '?Boolean' // defaults to true
  }, opts)

  EventEmitter.call(this)
  this.setMaxListeners(0)

  this._url = parseURL(opts.url)
  this._autoconnect = opts.autoconnect !== false
  this._onmessage = this._onmessage.bind(this)
  this._sessions = {}
  this._otrKey = opts.otrKey
  this._fingerprint = opts.otrKey.fingerprint()
  this._connected = false
  this._instanceTag = opts.instanceTag
  this._backoff = backoff.exponential({ initialDelay: 100 })
  if (this._autoconnect) this.connect()
}

util.inherits(Client, EventEmitter)
Client.OTR_ERROR = 'OTR error'
module.exports = Client

Client.prototype.connect = function () {
  var self = this

  if (this._socket) {
    this._socket.connect()
    return this._promiseConnected()
  }

  var base = this._url.protocol + '//' + this._url.host
  this._socket = io(base, { reconnection: false, path: this._url.path })
  this._socket.on('error', function (err) {
    debug('socket experienced error', err)
    self._socket.disconnect()
  })

  // TODO: implement handshake with relay
  if (false) {
    return this._handshake()
  } else {
    this._socket.on('message', this._onmessage)
    this._socket.on('disconnect', function () {
      if (self._destroyed) return

      self._debug('disconnected, reconnecting')
      self._connected = false
      self._closeSessions()
        .then(function () {
          return self._reconnect()
        })
    })

    this._socket.on('connect', function () {
      if (self._destroyed) return

      self._debug('connected')
      self._connected = true
      // make sure to emit 'subscribe'
      // before we start emitting 'message' on the socket
      self._socket.emit('subscribe', self._fingerprint)
      self.emit('connect')
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

Client.prototype._debug = function () {
  var args = Array.prototype.slice.call(arguments)
  args.unshift(this._fingerprint)
  return debug.apply(null, args)
}

Client.prototype._onmessage = function (msg, acknowledgeReceipt) {
  try {
    typeforce({
      from: 'String',
      message: MSG_CONTENT_TYPE
    }, msg)
  } catch (err) {
    debug('received invalid message')
    acknowledgeReceipt({ error: { message: 'invalid message' }})
    return
  }

  var session = this._sessions[msg.from]
  if (!session) {
    session = this._sessions[msg.from] = this._createSession(msg.from)
  }

  this._debug('msg from ' + msg.from)

  var err
  var otr = session.otr
  otr.on('error', onerror)
  otr.receiveMsg(msg.message)
  otr.removeListener('error', onerror)

  if (err) acknowledgeReceipt({ error: { message: Client.OTR_ERROR } })
  else acknowledgeReceipt()

  function onerror (e) {
    err = e
    otr.removeListener('error', onerror)
  }
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
// Client.prototype.addthem = function (rootHash, url) {
//   typeforce('String', rootHash)
//   typeforce('String', url)
//   this._thems[rootHash] = url
// }

Client.prototype.send = function (toRootHash, msg, identityInfo) {
  var self = this

  var toFingerprint = identityInfo.identity.pubkeys.filter(function (k) {
    return k.type === 'dsa'
  })[0].fingerprint

  var timeoutPromise = Q.Promise(function (resolve, reject) {
    setTimeout(function () {
      reject(new Error('timed out'))
    }, 10000)
  })

  if (!this._connected) {
    return Q.race([
      this.connect()
      .then(function () {
        return self.send(toFingerprint, msg, identityInfo)
      }),
      timeoutPromise
    ])
  }

  if (Buffer.isBuffer(msg)) msg = msg.toString(MSG_ENCODING)

  if (!this._sessions[toFingerprint]) {
    this._createSession(toFingerprint)
  }

  var attemptsLeft = 3
  var session = this._sessions[toFingerprint]
  var tryAFew = trySend()
    .catch(function (err) {
      if (err.message !== Client.OTR_ERROR || attemptsLeft-- <= 0) {
        throw err
      }

      self._debug('experienced OTR error, retrying')
      return trySend()
    })

  // TODO: deduplicate with above Q.race
  return Q.race([
    tryAFew,
    timeoutPromise
  ])

  function trySend () {
    var defer = Q.defer()
    session.otr.sendMsg(msg.toString(MSG_ENCODING), function () {
      setTimeout(function () {
        defer.reject(new Error('timed out'))
      }, 5000)

      // we just sent the last piece of this message
      // replace the placeholder we pushed
      //
      // yes, this is ugly
      session.currentMsgPieces[session.currentMsgPieces.length - 1].defer = defer
    })

    return defer.promise
  }
}

Client.prototype._rebootSession = function (theirFingerprint) {
  var self = this
  return this._destroySession(theirFingerprint)
    .then(function () {
      return self._createSession(theirFingerprint)
    })
}

Client.prototype._createSession = function (announcedFingerprint) {
  var self = this
  var otr = new OTR({
    debug: debug.enabled,
    priv: this._otrKey,
    instance_tag: this.instanceTag
  })

  var session = this._sessions[announcedFingerprint] = {
    them: announcedFingerprint,
    otr: otr,
    currentMsgPieces: []
  }

  if (this.instanceTag) {
    otr.ALLOW_V2 = false
  } else {
    otr.ALLOW_V3 = false
  }

  otr.REQUIRE_ENCRYPTION = true
  otr.on('ui', function (msg) {
    self.emit('message', new Buffer(msg, MSG_ENCODING), { fingerprint: session.them })
  })

  otr.on('io', function (msg, metadata) {
    session.currentMsgPieces.push({
      message: msg
    })

    process.nextTick(function () {
      self._processQueue(session)
    })
  })

  otr.on('error', function (err) {
    self._debug('otr err', err)
    self._rebootSession(announcedFingerprint)
  })

  otr.on('status', function (status) {
    self._debug('otr status', status)
    if (status !== OTR.CONST.STATUS_AKE_SUCCESS) return

    var theirActualFingerprint = otr.their_priv_pk.fingerprint()
    if (session.them !== theirActualFingerprint) {
      self.emit('fraud', {
        actualFingerprint: theirActualFingerprint,
        announcedFingerprint: announcedFingerprint
      })

      self._destroySession(announcedFingerprint)
      return
    }

    self._debug('AKE successful, their fingerprint: ' + session.them)
  })

  otr.sendQueryMsg()

  return session
}

Client.prototype._processQueue = function (session) {
  var self = this
  if (!this._connected) {
    this._debug('waiting for connect')
    return this.once('connect', this._processQueue.bind(this, session))
  }

  // clearTimeout(session.timeout)
  // session.timeout = setTimeout(this._destroySession.bind(this, session.recipient), SESSION_TIMEOUT)
  var currentMsgPieces = session.currentMsgPieces
  if (!currentMsgPieces.length) return

  this._socket.once('disconnect', resend)

  var next = currentMsgPieces.shift()
  this._socket.emit('message', {
    from: this._fingerprint,
    to: session.them,
    message: next.message
  }, function (ack) {
    self._socket.off('disconnect', resend)
    var defer = next.defer
    if (!(defer && defer.promise.isPending())) return

    self._debug('delivered message')
    if (ack && ack.error) {
      defer.reject(new Error(ack.error.message))
    } else {
      defer.resolve()
    }
  })

  function resend () {
    self._debug('resending')
    currentMsgPieces.unshift(next)
    self._processQueue(session)
  }
}

Client.prototype._destroySession = function (fingerprint) {
  var self = this
  var session = this._sessions[fingerprint]
  if (!session) return Q()

  return Q.ninvoke(session.otr, 'endOtr')
    .finally(function () {
      var s = self._sessions[fingerprint]
      s.currentMsgPieces.forEach(function (item) {
        var defer = item.defer
        if (defer) defer.reject(new Error('session destroyed'))
      })

      delete self._sessions[fingerprint]
    })
}

Client.prototype.destroy = function () {
  var self = this
  if (this._destroyed) return Q.reject(new Error('already destroyed'))

  this._debug('destroying')
  this._destroyed = true
  return this._closeSessions()
    .then(function () {
      self._socket.disconnect()
      delete self._sessions
    })
}

Client.prototype._closeSessions = function () {
  return Q.all(Object.keys(this._sessions).map(this._destroySession, this))
}

Client.prototype._reconnect = function () {
  var self = this
  this._backoff.reset()
  this._backoff.removeAllListeners()
  this._backoff.backoff()
  this._backoff.on('ready', function () {
    self._debug('backing off and reconnecting')
    self._backoff.backoff()
    self._socket.connect()
  })

  this._socket.once('connect', function () {
    self._backoff.reset()
  })
}
