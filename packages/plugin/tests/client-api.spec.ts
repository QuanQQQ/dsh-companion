import assert from 'node:assert/strict'
import test from 'node:test'
import { approveEnrollment, denyEnrollment } from '../src/client/api.js'

test('browser approval and denial send the JSON media type required by Host', async t => {
  const paths: string[] = []
  t.mock.method(globalThis,'fetch',async(input:RequestInfo|URL,init?:RequestInit)=>{
    paths.push(String(input))
    assert.equal(init?.method,'POST')
    assert.equal(new Headers(init?.headers).get('content-type'),'application/json')
    assert.equal(init?.body,'{}')
    return Response.json({ok:true})
  })
  await approveEnrollment('own-id')
  await denyEnrollment('own-id')
  assert.deepEqual(paths,['/api/companion/enrollments/own-id/approve','/api/companion/enrollments/own-id/deny'])
})
