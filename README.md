# hyproxy

A very simple peer-to-peer proxy that uses [hypercore-protocol](https://hypercore-protocol.org/) to proxy any TCP connection over hyperswarm and hypercore-protocol.

This provides an easy way to e.g. share an HTTP server running on your computer with friends, without having to deal with port forwardings etc, because Hypercore Protocol handles this for you.

*Note: This is an experiment and not (yet) intended for anything serious.*

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
$ hyproxy connect -k 1d73a82039cd90efb78331778048be85cce1a1c0147085b110579be4ceee62f5
outbound proxy to 1d73a82039cd90efb78331778048be85cce1a1c0147085b110579be4ceee62f5 opened.
access via localhost:9999
```
and then your friends can open [`http://localhost:9999`](http://localhost:9999) to access the HTTP server you just opened.

## Usage

```
USAGE: hyproxy [options] <listen|connect>

Options in listen mode:
 -p, --port     Port to proxy to (required)
 -h, --host     Hostname to proxy to (default: localhost)
 -s, --storage  Storage directory to persist keys across restarts (optional)

Options in connect mode:
 -k, --key      Key to connect to (required)
 -p, --port     Port for local proxy server (default: 9999)
 -h, --host     Hostname for local proxy server (default: localhost)
```
