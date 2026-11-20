import assert from "node:assert/strict";
import http from "node:http";
import https from "node:https";
import { EnvHttpProxyAgent, getGlobalDispatcher, setGlobalDispatcher } from "undici";

const keys = ["NODE_USE_ENV_PROXY", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY"];
const env = [...keys, ...keys.map((key) => key.toLowerCase())].map((key) => [key, process.env[key]]);
const httpAgent = http.globalAgent;
const httpsAgent = https.globalAgent;
const dispatcher = new EnvHttpProxyAgent();
setGlobalDispatcher(dispatcher);

export function assertProxiesIsolated() {
  for (const [key] of env) assert.equal(process.env[key], undefined, key);
  assert.notEqual(http.globalAgent, httpAgent);
  assert.notEqual(https.globalAgent, httpsAgent);
  assert.notEqual(getGlobalDispatcher(), dispatcher);
}

export function assertProxiesRestored() {
  for (const [key, value] of env) assert.equal(process.env[key], value, key);
  assert.equal(http.globalAgent, httpAgent);
  assert.equal(https.globalAgent, httpsAgent);
  assert.equal(getGlobalDispatcher(), dispatcher);
}
