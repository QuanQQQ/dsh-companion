import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { ForwardLease, ForwardOperation } from '../src/domain.js'
import {
  digestOperation,
  makeForwardClose,
  makeForwardOpen,
  parseDeviceFrame,
  verifyOperationDigest,
  type ForwardOpenFrame,
} from '../src/protocol.js'

const fence = { authorityEpoch: 'authority-a', sessionEpoch: 'session-a' }
const lease: ForwardLease = {
  id: 'lease-a',
  serviceId: 'service-a',
  deviceId: 'device-a',
  localHost: '127.0.0.1',
  localPort: 5173,
  remoteHost: '127.0.0.1',
  remotePort: 5173,
  desiredState: 'open',
  generation: 1,
  createdAt: '2026-09-07T00:00:00.000Z',
  updatedAt: '2026-09-07T00:00:00.000Z',
  expiresAt: '2026-09-07T02:00:00.000Z',
}
const openOperation: ForwardOperation = {
  id: 'op-open',
  leaseId: lease.id,
  deviceId: lease.deviceId,
  generation: 1,
  kind: 'open',
  createdAt: lease.createdAt,
}

describe('constrained Host operations', () => {
  it('encodes only an identical port rather than accepting hosts or SSH options', () => {
    const frame = makeForwardOpen(fence, lease, openOperation, 'http')

    assert.equal(frame.port, 5173)
    assert.equal('localHost' in frame, false)
    assert.equal('remoteHost' in frame, false)
    assert.equal('sshArgs' in frame, false)
    assert.equal('proxyCommand' in frame, false)
    assert.equal(verifyOperationDigest(frame), true)
  })

  it('detects any changed canonical payload under the same operation identity', () => {
    const frame = makeForwardOpen(fence, lease, openOperation, 'http')
    const tampered = { ...frame, port: 5174 } as ForwardOpenFrame

    assert.equal(verifyOperationDigest(tampered), false)
    const { digest: _digest, ...payload } = frame
    const reordered = {
      expiresAt: payload.expiresAt,
      port: payload.port,
      generation: payload.generation,
      leaseId: payload.leaseId,
      operationId: payload.operationId,
      sessionEpoch: payload.sessionEpoch,
      authorityEpoch: payload.authorityEpoch,
      protocol: payload.protocol,
      type: payload.type,
      v: payload.v,
    }
    assert.equal(digestOperation(reordered), frame.digest)
    assert.equal(makeForwardOpen({ ...fence, sessionEpoch: 'session-b' }, lease, openOperation, 'http').digest, frame.digest)
  })

  it('permits restart close and open operations in successive generations', () => {
    const restartedLease = { ...lease, generation: 3 }
    const close: ForwardOperation = { ...openOperation, id: 'op-close', kind: 'close', generation: 2 }
    const frame = makeForwardClose(fence, restartedLease, close)

    assert.equal(frame.generation, 2)
    assert.equal(verifyOperationDigest(frame), true)
  })
})

describe('strict Device frame parsing', () => {
  it('accepts a fenced operation result with an Instance observation', () => {
    const frame = parseDeviceFrame(JSON.stringify({
      v: 1,
      type: 'forward.result',
      ...fence,
      operationId: 'op-open',
      digest: 'a'.repeat(64),
      ok: true,
      observation: {
        leaseId: 'lease-a',
        generation: 1,
        state: 'running',
        sshChild: 'running',
        listener: 'owned',
        remoteProbe: 'healthy',
        processId: 123,
      },
    }))

    assert.equal(frame.type, 'forward.result')
    assert.equal(frame.authorityEpoch, 'authority-a')
    assert.equal(frame.sessionEpoch, 'session-a')
  })

  it('rejects unknown fields so a Device cannot smuggle authority-bearing data', () => {
    assert.throws(() => parseDeviceFrame(JSON.stringify({
      v: 1,
      type: 'device.hello',
      ...fence,
      companionVersion: '0.1.0',
      remoteHost: '0.0.0.0',
    })), /unexpected frame field/)
  })

  it('rejects stale protocol versions and unbounded Instance arrays', () => {
    assert.throws(() => parseDeviceFrame(JSON.stringify({
      v: 2,
      type: 'pong',
      ...fence,
      nonce: 'n',
    })), /unsupported Companion protocol version/)

    assert.throws(() => parseDeviceFrame(JSON.stringify({
      v: 1,
      type: 'forward.list',
      ...fence,
      requestId: 'request-a',
      instances: Array.from({ length: 1_001 }, () => ({})),
    })), /bounded array/)
  })
})
