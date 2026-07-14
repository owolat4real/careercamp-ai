'use strict'
const http  = require('http')
const https = require('https')

/* Persistent TCP connections — eliminates 10-40ms handshake per request */
const httpAgent = new http.Agent({
  keepAlive:   true,
  maxSockets:  20,
  timeout:     60_000,
})

const httpsAgent = new https.Agent({
  keepAlive:   true,
  maxSockets:  20,
  timeout:     60_000,
})

module.exports = { httpAgent, httpsAgent }
