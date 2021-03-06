
var path = require('path')
var test = require('tape')
var Q = require('q')
var ROOT_HASH = require('@tradle/constants').ROOT_HASH
var utils = require('@tradle/utils')
var DSA = require('@tradle/otr').DSA
var WebSocketRelay = require('@tradle/ws-relay')
var WebSocketClient = require('../')
var billPub = require('./fixtures/bill-pub')
var billPriv = require('./fixtures/bill-priv')
var tedPub = require('./fixtures/ted-pub')
var tedPriv = require('./fixtures/ted-priv')
var rufusPub = require('./fixtures/rufus-pub')
var rufusPriv = require('./fixtures/rufus-priv')
var BASE_PORT = 22222
var billRootHash
var tedRootHash
var rufusRootHash
var people = {}

test('setup', function (t) {
  Q.all([billPub, tedPub, rufusPub].map(function (identity) {
    return Q.ninvoke(utils, 'getStorageKeyFor', new Buffer(utils.stringify(identity)))
  })).spread(function (b, t, r) {
    b = b.toString('hex')
    t = t.toString('hex')
    r = r.toString('hex')

    billRootHash = b
    tedRootHash = t
    rufusRootHash = r

    people[b] = people.bill = {
      pub: billPub,
      priv: billPriv
    }

    people[t] = people.ted = {
      pub: tedPub,
      priv: tedPriv
    }

    people[r] = people.rufus = {
      pub: rufusPub,
      priv: rufusPriv
    }
  })
  .done(t.end)
})

test('websockets with relay', function (t) {
  var port = BASE_PORT++

  var relayPath = '/custom/relay/path'
  var relay = new WebSocketRelay({
    port: port,
    path: relayPath
  })

  var rufusDSA = getDSAKey(rufusPriv)
  var billDSA = getDSAKey(billPriv)

  var relayURL = 'http://127.0.0.1:' + port + path.join('/', relayPath)
  var rufus = new WebSocketClient({
    url: relayURL,
    otrKey: rufusDSA
  })

  var bill = new WebSocketClient({
    url: relayURL,
    otrKey: billDSA,
    autoconnect: false
  })

  var onmsg = bill._onmessage
  // in this test,
  // 4 comes at the last piece of a message
  var errored = 4
  bill._onmessage = function (msg, acknowledge) {
    if (errored-- === 0) {
      errored = true
      return acknowledge({ error: { message: WebSocketClient.OTR_ERROR } })
    }

    return onmsg.apply(bill, arguments)
  }

  bill.connect()
  bill.once('connect', function () {
    bill._socket.ondisconnect()
  })

  var rufusInfo = {
    identity: rufusPub
  }

  rufusInfo[ROOT_HASH] = rufusRootHash

  var billInfo = {
    identity: billPub
  }

  billInfo[ROOT_HASH] = billRootHash

  var togo = 2

  var send1 = bill.send(rufusRootHash, toBuffer({
    hey: 'rufus'
  }), rufusInfo)

  var send2 = rufus.send(billRootHash, toBuffer({
    hey: 'bill'
  }), billInfo)

  bill.on('message', function (msg) {
    done()
    t.equal(JSON.parse(msg).hey, 'bill')
  })

  rufus.on('message', function (msg) {
    done()
    t.equal(JSON.parse(msg).hey, 'rufus')
  })

  function done () {
    if (--togo) return

    Q.all([send1, send2])
    .then(function () {
      return Q.all([
        relay.destroy(),
        bill.destroy(),
        rufus.destroy()
      ])
    })
    .done(function () {
      t.end()
      // Socket.IO takes ~30 seconds to clean up (timeout its connections)
      // no one wants to wait that long for tests to finish
      process.exit(0)
    })
  }
})

function toBuffer (obj) {
  return new Buffer(utils.stringify(obj))
}

function getDSAKey (keys) {
  var key = keys.filter(function (k) {
    return k.type === 'dsa'
  })[0]

  return DSA.parsePrivate(key.priv)
}
