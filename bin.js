#!/usr/bin/env node

const minimist = require('minimist')
const HyperProxy = require('.')

const argv = minimist(process.argv.slice(2), {
  alias: {
    p: 'port',
    h: 'host',
    k: 'key',
    s: 'storage'
  }
})

const mode = argv._[0]
main(mode, argv).catch(onerror)

async function main (mode, opts) {
  const proxy = new HyperProxy({ storage: opts.storage })
  if (mode === 'connect') {
    const { key, port, host } = await proxy.outbound(opts.key, opts.port, opts.host)
    console.log(`outbound proxy to ${key} connected.\naccess via ${host}:${port}`)
  } else if (mode === 'listen') {
    const { key, port, host } = await proxy.inbound(opts.key, opts.port, opts.host)
    console.log(`inbound proxy to ${host}:${port} listening.\naccess via ${key}`)
  } else {
    onerror()
  }
  // wait forever
  // TODO: Die on errors ;)
  await new Promise(resolve => {})
}

function onerror (err) {
  if (err) console.error(err.message)
  console.error(`USAGE: hyproxy [options] <listen|connect>

Options in listen mode:
 -p, --port     Port to proxy to (required)
 -h, --host     Hostname to proxy to (default: localhost)
 -s, --storage  Storage directory to persist keys across restarts (optional)

Options in connect mode:
 -k, --key      Key to connect to (required)
 -p, --port     Port for local proxy server (default: 9999)
 -h, --host     Hostname for local proxy server (default: localhost)
 `)
}
