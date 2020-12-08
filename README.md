# hyproxy

A peer-to-peer proxy server and client that uses [Hypercore Protocol](https://hypercore-protocol.org/) to proxy TCP connections over hyperswarm and hypercore-protocol.

This provides an easy way to e.g. share an HTTP server running on your computer with friends, without having to deal with port forwardings etc, because Hypercore Protocol handles this for you.

*This is an experiment and not yet tested for anything serious.*

- When opening an inbound proxy server, a random `key` will be created and printed
- There can be more than one inbound proxy per key. Currently, the first connection is used, and others are fallbacks if the first fails.
- Anyone who knows this `key` can connect to an inbound proxy and expose it as a local server, or create a new inbound proxy.
- *TODO:* Add optional capability creation/verification when connecting to inbound proxies

## Installation

```sh
npm install -g hyproxy
```

## Example

Let's say you want to share a HTTP server from your computer with friends. Maybe to quickly share some files, or to test some web app, or whatever. For example, you can `npm install -g http-server` for a simple http server.

Now, you can do the following:
```
$ http-server /some/directory

Starting up http-server, serving .
Available on:
  http://127.0.0.1:8080

$ hyproxy listen -p 8080

inbound proxy to localhost:8080 listening.
access via f1dd4fa6801a659168c48eab3018f168a621f58677f5cfa6e495da16a7dd5218
```
and then send the printed long key to others. they can then do:
```
$ hyproxy connect -k f1dd4fa6801a659168c48eab3018f168a621f58677f5cfa6e495da16a7dd5218
outbound proxy to f1dd4fa6801a659168c48eab3018f168a621f58677f5cfa6e495da16a7dd5218 opened.
access via localhost:9999
```
and then your friends can open [`http://localhost:9999`](http://localhost:9999) to access the HTTP server you just opened.

## Command-line usage

```
USAGE: hyproxy [options] <listen|connect>

Options in listen mode:
 -p, --port     Port to proxy to (required)
 -h, --host     Hostname to proxy to (default: localhost)
 -s, --storage  Storage directory to persist keys across restarts (optional)

Options in connect mode:
 -k, --key      Key to connect to (required)
 -p, --port     Port for local proxy server (default: 9990 or a free port)
 -h, --host     Hostname for local proxy server (default: localhost)
```

## API usage

```javascript
const HyperProxy = require('hyproxy')
const hyproxy = new HyperProxy({ storage: '/tmp/hyproxy' })
await hyproxy.outbound(key, port, host)
```

#### `proxy = new HyperProxy(opts)`

Create a new proxy manager.

Options include:
- `storage`: Storage to persist keys (optional, default to in-memory)
- `corestore`: Pass your [corestore](https://github.com/andrewosh/corestore) instance (optional)
- `corestore`: Pass your [@corestore/networker](https://github.com/andrewosh/corestore-networker) instance (optional)

#### `await proxy.outbound(key, port, host)`

Create a new outbound proxy that connects to a peer on `key` and exposes a local proxy server on `host:port`.

- `key`: The key to an inbound hyproxy server (required)
- `port`: Port for local proxy server (defaults to a free port)
- `host`: Hostname on which the local proxy server binds (defaults to `localhost`)

Returns an object with `{ key, port, host }`.

#### `await proxy.inbound(key, port, host)`

Create a new inbound proxy that listens for peers on `key` and forwards connections to `host:port`.

- `key`: Hypercore key to accept connections on. May be `null`, then the key will be derived so that it stays the same for the same `host:port` pairs (if storage is not inmemory)
- `port`: Port to forward connections to (required)
- `host`: Host to forward connections to

Returns an object with `{ key, port, host }`.
