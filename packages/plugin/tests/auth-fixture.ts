import type { CompanionRequestAuthenticator } from '../src/owner-browser.js'

export function browserAuth(accept: (req: {headers: any}) => boolean = () => true): CompanionRequestAuthenticator {
  const browserPeer = { id: 'fixture-browser', principal: {kind:'owner'}, signal: new AbortController().signal } as CompanionRequestAuthenticator['browserPeer']
  return { browserPeer, admit: req => accept(req) ? {peer:browserPeer} : {rejection:401} }
}
