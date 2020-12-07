const net = require('net')
const prettyHash = require('pretty-hash')
const Corestore = require('corestore')
const Networker = require('@corestore/networker')
const ram = require('random-access-memory')
const debug = require('debug')('hyperproxy')

const TYP_DISCOVER = 0
const TYP_ACK = 1
const TYP_CONNECT = 2
const TYP_DATA = 3
const TYP_CLOSE = 4

const NAMESPACE = 'hypercore-tcp-proxy'
const EXTENSION_NAME = NAMESPACE + ':extension'

const kChannel = Symbol('channel-key')
const kRemoteClosed = Symbol('remote-closed')

module.exports = class HyperProxy {
  constructor (opts = {}) {
    this._corestore = opts.corestore || new Corestore(opts.storage || ram)
    this._networker = opts.networker || new Networker(this._corestore)
  }

  async open () {
    if (this.opened) return
    await new Promise((resolve, reject) => {
      this._corestore.ready(err => err ? reject(err) : resolve())
    })
    debug(`INIT, pubKey: ${prettyHash(this._networker.keyPair.publicKey)}`)
    this.opened = true
  }

  async outbound (key, port = 9999, host = 'localhost') {
    await this.open()

    if (!key) throw new Error('Key is required')
    const feed = this._corestore.get({ key })

    return new Promise((resolve, reject) => {
      feed.ready(() => {
        const proxy = new OutboundProxy(port, host)
        proxy.registerExtension(feed)
        this._networker.configure(feed.discoveryKey, { announce: true })
        process.nextTick(() => {
          proxy.listen()
          resolve({ port, host, key: feed.key.toString('hex') })
        })
      })
    })
  }

  async inbound (key, port, host = 'localhost') {
    await this.open()

    if (!port) throw new Error('port is required')
    let feed
    if (!key) {
      const name = [NAMESPACE, host, port].join(':')
      feed = this._corestore.namespace(name).default()
    } else {
      feed = this._corestore.get({ key })
    }

    return new Promise((resolve, reject) => {
      feed.ready((err) => {
        if (err) return reject(err)
        const proxy = new InboundProxy(port, host)
        proxy.registerExtension(feed)
        this._networker.configure(feed.discoveryKey, { lookup: true })
        resolve({ port, host, key: feed.key.toString('hex') })
      })
    })
  }
}

class TcpExtension {
  constructor (handlers) {
    this.handlers = handlers
    this._peers = new Set()
  }

  registerExtension (feed) {
    const self = this
    const ext = feed.registerExtension(EXTENSION_NAME, {
      encoding: 'binary',
      onmessage (message, peer) {
        const { type, id, data } = decodeMessage(message)
        self.onmessage(peer, type, id, data)
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

  onmessage (peer, type, id, data) {
    debug(`ONMESSAGE from ${fmtPeer(peer)} type ${type} id ${id} len ${data.length}`)
    if (type === TYP_DISCOVER) return this.handlers.ondiscover(peer, id, data)
    if (type === TYP_ACK) return this.handlers.onack(peer, id, data)
    if (type === TYP_CONNECT) return this.handlers.onconnect(peer, id, data)
    if (type === TYP_DATA) return this.handlers.ondata(peer, id, data)
    if (type === TYP_CLOSE) return this.handlers.onclose(peer, id, data)
  }

  send (peer, id, type, data) {
    debug(`SEND to ${fmtPeer(peer)} type ${type} id ${id} len ${data && data.length}`)
    const buf = encodeMessage(id, type, data)
    this.ext.send(buf, peer)
  }

  broadcast (id, type, data) {
    debug(`BROADCAST type ${type} id ${id} len ${data && data.length}`)
    const buf = encodeMessage(id, type, data)
    this.ext.broadcast(buf)
  }
}

class InboundProxy {
  constructor (port, host) {
    this.ext = new TcpExtension(this)
    this.port = port
    this.host = host
    this._connections = new Map()
  }

  registerExtension (feed) {
    this.ext.registerExtension(feed)
  }

  ondiscover (peer, id, data) {
    this.ext.send(peer, id, TYP_ACK)
  }

  onack () {}

  onconnect (peer, id, data) {
    const channel = channelId(peer, id)
    const socket = net.connect(this.port, this.host)
    this._connections.set(channel, socket)
    socket.on('data', data => {
      this.ext.send(peer, id, TYP_DATA, data)
    })
    socket.on('error', () => {
      if (!socket[kRemoteClosed]) this.ext.send(peer, id, TYP_CLOSE)
    })
    socket.on('close', () => {
      if (!socket[kRemoteClosed]) this.ext.send(peer, id, TYP_CLOSE)
      this._connections.delete(channel)
    })
  }

  ondata (peer, id, data) {
    const channel = channelId(peer, id)
    const socket = this._connections.get(channel)
    if (!socket) return
    socket.write(data)
  }

  onclose (peer, id, data) {
    const channel = channelId(peer, id)
    const socket = this._connections.get(channel)
    if (!socket) return
    socket[kRemoteClosed] = true
    socket.destroy(new Error('Remote socket closed'))
  }
}

class OutboundProxy {
  constructor (port, host) {
    this.ext = new TcpExtension(this)
    this.port = port
    this.host = host
    this._connections = new Map()
    this._cnt = 0
  }

  registerExtension (feed) {
    this.ext.registerExtension(feed)
  }

  listen () {
    this.socket = net.createServer(this.ontcpconnection.bind(this))
    this.socket.listen(this.port, this.host)
    this.ext.broadcast(0, TYP_DISCOVER)
  }

  onpeeropen (peer) {
    if (!this._peer) this.ext.send(peer, 0, TYP_DISCOVER)
  }

  onpeerclose (peer) {
    const remoteKey = peer.remotePublicKey.toString('hex')
    if (this._peer && remoteKey === this._peer.remotePublicKey.toString('hex')) {
      this._peer = null
      for (const socket of this._connections.values()) {
        socket.destroy(new Error('Lost remote connection'))
      }
      this.ext.broadcast(0, TYP_DISCOVER)
    }
  }

  ondiscover () {}

  onack (peer, id, data) {
    // TODO: Verify the peer somehow.
    if (!this._peer) this._peer = peer
  }

  ondata (peer, id, data) {
    const channel = channelId(peer, id)
    const socket = this._connections.get(channel)
    if (!socket) return
    socket.write(data)
  }

  onclose (peer, id, data) {
    const channel = channelId(peer, id)
    const socket = this._connections.get(channel)
    if (!socket) return
    socket.destroy()
  }

  ontcpconnection (socket) {
    const id = ++this._cnt

    socket.on('error', err => {
      console.error('Socket closed: ' + err.message)
      if (this._peer) this.ext.send(this._peer, id, TYP_CLOSE)
      if (socket[kChannel]) this._connections.delete(socket[kChannel])
    })

    if (!this._peer) return socket.destroy(new Error('No remote connection'))

    const channel = channelId(this._peer, id)
    socket[kChannel] = channel
    this._connections.set(channel, socket)
    this.ext.send(this._peer, id, TYP_CONNECT)
    socket.on('data', data => {
      if (this._peer) this.ext.send(this._peer, id, TYP_DATA, data)
      else socket.destroy(new Error('Remote connection lost'))
    })
    socket.on('close', () => {
      if (this._peer) this.ext.send(this._peer, id, TYP_CLOSE)
      this._connections.delete(channel)
    })
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

function channelId (peer, id) {
  return peer.remotePublicKey.toString('hex') + '!' + id
}

function fmtPeer (peer) {
  return prettyHash(peer.remotePublicKey)
}
