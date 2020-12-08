const net = require('net')
const prettyHash = require('pretty-hash')
const Corestore = require('corestore')
const Networker = require('@corestore/networker')
const ram = require('random-access-memory')
const debug = require('debug')('hyproxy')
const getPort = require('get-port')
const { EventEmitter } = require('events')

const TYP_DISCOVER = 0
const TYP_ACK = 1
const TYP_CONNECT = 2
const TYP_DATA = 3
const TYP_CLOSE = 4

const NAMESPACE = 'hyproxy-v1'
const EXTENSION_NAME = NAMESPACE + ':extension'

const kRemoteClosed = Symbol('remote-closed')

module.exports = class HyperProxy extends EventEmitter {
  constructor (opts = {}) {
    super()
    this._corestore = opts.corestore || new Corestore(opts.storage || ram)
    this._networker = opts.networker || new Networker(this._corestore)
  }

  async open () {
    if (this.opened) return
    await new Promise((resolve, reject) => {
      this._corestore.ready(err => err ? reject(err) : resolve())
    })
    debug(`init, pubKey: ${prettyHash(this._networker.keyPair.publicKey)}`)
    this.opened = true
  }

  async outbound (key, port, host = 'localhost') {
    await this.open()

    if (!key) throw new Error('Key is required')
    const feed = await this._feed(key)

    const proxy = new OutboundProxy(feed, { port, host })
    await proxy.listen()
    proxy.on('error', err => this.emit('error', err))

    this._networker.configure(feed.discoveryKey, { announce: true })
    return proxy
  }

  async inbound (key, port, host = 'localhost') {
    await this.open()
    if (!port) throw new Error('Port is required')

    let name = null
    if (!key) name = [NAMESPACE, host, port].join(':')
    const feed = await this._feed(key, name)

    const proxy = new InboundProxy(feed, { port, host })
    proxy.on('error', err => this.emit('error', err))

    this._networker.configure(feed.discoveryKey, { lookup: true })
    return proxy
  }

  async _feed (key, name) {
    if (name) {
      var feed = this._corestore.namespace(name).default()
    } else {
      feed = this._corestore.get({ key })
    }
    await new Promise((resolve, reject) => {
      feed.ready(err => err ? reject(err) : resolve())
    })
    return feed
  }
}

class HyproxyExtension {
  constructor (handlers) {
    this.handlers = handlers
  }

  registerExtension (feed) {
    const self = this
    const ext = feed.registerExtension(EXTENSION_NAME, {
      onmessage (message, peer) {
        const { type, id, data } = decodeMessage(message)
        self.onmessage(peer, type, id, data)
      },
      onerror (err) {
        self.onerror(err)
      }
    })
    feed.on('peer-open', peer => {
      debug('peer-open', fmtPeer(peer))
      if (this.handlers.onpeeropen) this.handlers.onpeeropen(peer)
    })
    feed.on('peer-remove', peer => {
      debug('peer-close', fmtPeer(peer))
      if (this.handlers.onpeerclose) this.handlers.onpeerclose(peer)
    })
    this.ext = ext
  }

  onerror (err) {
    if (this.handlers.onerror) this.handlers.onerror(err)
    else throw err
  }

  onmessage (peer, type, id, data) {
    debug(`recv from ${fmtPeer(peer)}:${id} typ ${type} len ${data.length}`)
    if (type === TYP_DISCOVER) return this.handlers.ondiscover(peer, id, data)
    if (type === TYP_ACK) return this.handlers.onack(peer, id, data)
    if (type === TYP_CONNECT) return this.handlers.onconnect(peer, id, data)
    if (type === TYP_DATA) return this.handlers.ondata(peer, id, data)
    if (type === TYP_CLOSE) return this.handlers.onclose(peer, id, data)
  }

  send (peer, id, type, data) {
    debug(`send to ${fmtPeer(peer)}:${id} typ ${type} len ${(data && data.length) || 0}`)
    const buf = encodeMessage(id, type, data)
    this.ext.send(buf, peer)
  }

  broadcast (id, type, data) {
    debug(`broadcast type ${type} id ${id} len ${data && data.length}`)
    const buf = encodeMessage(id, type, data)
    this.ext.broadcast(buf)
  }
}

class ProxyBase extends EventEmitter {
  constructor (feed) {
    super()
    this.connections = new PeerMap()
    this.ext = new HyproxyExtension(this)
    this.ext.registerExtension(feed)
    this.key = feed.key
  }

  addSocket (peer, id, socket) {
    this.connections.set(peer, id, socket)
    socket.on('data', data => {
      this.ext.send(peer, id, TYP_DATA, data)
    })
    socket.on('error', (err) => {
      debug(`socket ${fmtPeer(peer)}:${id} closed (${err.message})`)
    })
    socket.on('close', () => {
      if (!socket[kRemoteClosed]) this.ext.send(peer, id, TYP_CLOSE)
      debug(`socket ${fmtPeer(peer)}:${id} closed`)
      this.connections.delete(peer, id)
    })
  }

  ondata (peer, id, data) {
    const socket = this.connections.get(peer, id)
    if (!socket) return
    socket.write(data)
  }

  onclose (peer, id, data) {
    const socket = this.connections.get(peer, id)
    if (!socket) return
    socket[kRemoteClosed] = true
    socket.destroy()
  }

  onpeerclose (peer) {
    const err = new Error('Peer connection lost')
    this.connections.foreach(peer, socket => {
      socket[kRemoteClosed] = true
      socket.destroy(err)
    })
    this.connections.delete(peer)
  }

  onerror (err) {
    this.emit('error', err)
  }
}

class InboundProxy extends ProxyBase {
  constructor (feed, { port, host }) {
    super(feed)
    this.port = port
    this.host = host
  }

  ondiscover (peer, id, data) {
    this.ext.send(peer, id, TYP_ACK)
  }

  onack () {
    // do nothing
  }

  onconnect (peer, id, data) {
    const socket = net.connect(this.port, this.host)
    this.addSocket(peer, id, socket)
  }
}

class OutboundProxy extends ProxyBase {
  constructor (feed, { port, host }) {
    super(feed)
    this.port = port
    this.host = host
    this.server = net.createServer(this.ontcpconnection.bind(this))
    this.peers = new Set()
    this._cnt = 0
  }

  async listen () {
    if (!this.port) {
      this.port = await getPort({ port: getPort.makeRange(9990, 9999) })
    }
    await new Promise((resolve, reject) => {
      this.server.listen(this.port, this.host, err => {
        err ? reject(err) : resolve()
      })
    })
    this.server.on('error', err => this.emit('error', err))
    this.ext.broadcast(0, TYP_DISCOVER)
  }

  onpeeropen (peer) {
    this.ext.send(peer, 0, TYP_DISCOVER)
  }

  onpeerclose (peer) {
    super.onpeerclose(peer)
    this.peers.delete(peer)
  }

  ondiscover () {
    // do nothing
  }

  onack (peer, id, data) {
    // TODO: Verify the peer somehow, check a capability.
    this.peers.add(peer)
  }

  ontcpconnection (socket) {
    const peer = this._selectPeer()
    if (!peer) return socket.destroy()
    const id = ++this._cnt
    this.addSocket(peer, id, socket)
    this.ext.send(peer, id, TYP_CONNECT)
  }

  _selectPeer () {
    const peers = Array.from(this.peers.values())
    if (!peers.length) return null
    return peers[0]
  }
}

class PeerMap {
  constructor (onclose) {
    this.map = new Map()
  }

  set (peer, id, socket) {
    if (!this.has(peer, null)) this.map.set(rkey(peer), new Map())
    if (id !== null) this.get(peer, null).set(id, socket)
  }

  delete (peer, id) {
    if (!this.has(peer)) return
    if (id !== null) return this.get(peer).delete(id)
    this.map.delete(rkey(peer))
  }

  foreach (peer, fn) {
    if (!this.has(peer)) return
    for (const socket of this.get(peer).values()) {
      fn(socket)
    }
  }

  get (peer, id) {
    if (!this.has(peer, id)) return null
    if (id === null) return this.map.get(rkey(peer))
    return this.map.get(rkey(peer)).get(id)
  }

  has (peer, id) {
    if (id === null) return this.map.has(rkey(peer))
    if (!this.map.has(rkey(peer))) return false
    return this.map.get(rkey(peer)).has(id)
  }
}

function encodeMessage (id, type, data) {
  if (!data) data = Buffer.alloc(0)
  if (!Buffer.isBuffer(data)) data = Buffer.from(data)
  const header = id << 4 | type
  const headerBuf = Buffer.alloc(4)
  headerBuf.writeUInt32LE(header)
  return Buffer.concat([headerBuf, data])
}

function decodeMessage (buf) {
  const headerBuf = buf.slice(0, 4)
  const header = headerBuf.readUInt32LE()
  const type = header & 0b1111
  const id = header >> 4
  const data = buf.slice(4)
  return { type, id, data }
}

function fmtPeer (peer) {
  return prettyHash(peer.remotePublicKey)
}

function rkey (peer) {
  return peer.remotePublicKey.toString('hex')
}
