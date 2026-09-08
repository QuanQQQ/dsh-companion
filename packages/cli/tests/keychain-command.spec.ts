import assert from 'node:assert/strict'
import test from 'node:test'
import { MacKeychain, securityInput } from '../src/keychain.js'
import { systemCommandRunner, type CommandOptions, type CommandRunner } from '../src/command.js'

// State-machine transcription of Apple's security.c split_line, not a shell parser.
// https://github.com/apple-oss-distributions/Security/blob/main/SecurityTool/macOS/security.c
function splitSecurityLine(line: string): string[] {
  let state = 'space', quote = '', current = ''
  const args: string[] = []
  for (const c of line) {
    if (state === 'space') {
      if (/\s/.test(c)) continue
      current = ''
      if (c === '"' || c === "'") { quote = c; state = 'quote'; continue }
      state = 'arg'
    }
    if (state === 'arg') {
      if (c === '\\') { state = 'arg_escape'; continue }
      else if (/\s/.test(c)) { args.push(current); state = 'space' }
      else current += c
    }
    if (state === 'quote') {
      if (c === '\\') { state = 'quote_escape'; continue }
      if (c === quote) { args.push(current); state = 'space' }
      else current += c
    }
    if (state === 'arg_escape') { current += c; state = 'arg' }
    if (state === 'quote_escape') { current += c; state = 'quote' }
  }
  if (state !== 'space') args.push(current)
  return args
}

test('security stdin strict escaping roundtrips punctuation, quotes, slash and Unicode', () => {
  const values = ['add-generic-password', '-w', 'a"b\\c\' ; $(touch /tmp/no) 中文 🔒' + String.fromCharCode(96), '', 'ends\\', ' x ']
  const input = securityInput(values)
  assert.deepEqual(splitSecurityLine(input), values)
  assert.equal(input.split('\n').length, 2)
  assert.ok(!input.endsWith('quit\n'))
  for (const value of ['abc\nquit', 'a\r', 'a\0', 'a\t', 'a\x7f']) assert.throws(() => securityInput([value]), /control/)
  assert.throws(() => securityInput(['🔒'.repeat(1_024)]), /length/)
  assert.throws(() => securityInput(['x'.repeat(4_093)]), /length/)
})

test('Keychain token travels only via stdin and is read back without whitespace loss', async () => {
  const calls: { args: readonly string[]; options?: CommandOptions | undefined }[] = []
  const token = ' dsht_"quote\\slash\' end '
  let saved = ''
  const runner: CommandRunner = { async run(file, args, options) {
    assert.equal(file, '/usr/bin/security')
    calls.push({ args, options })
    assert.ok(!args.some(arg => arg.includes(token)))
    if (args[0] === '-i') {
      assert.deepEqual(args, ['-i'])
      const words = splitSecurityLine(options!.stdin!)
      assert.equal(words[0], 'add-generic-password')
      assert.ok(!words.includes('-U'))
      saved = words.at(-1)!
      return { code: 0, stdout: '', stderr: '' }
    }
    return { code: 0, stdout: saved + '\n', stderr: '' }
  } }
  const keychain = new MacKeychain(runner)
  await keychain.store('dev_fixture', token)
  assert.equal(await keychain.read('dev_fixture'), token)
  assert.equal(calls[0]?.options?.stdin, securityInput(['add-generic-password', '-a', 'dev_fixture', '-s', 'dev.deepseek.dsh-companion', '-w', token]))
})

test('Keychain write failure redacts output; verification failure cleans new item', async () => {
  const secret = 'do-not-print-this-token'
  await assert.rejects(new MacKeychain({ async run() { return { code: 1, stdout: secret, stderr: secret } } }).store('dev', secret), error => {
    assert.ok(error instanceof Error)
    assert.ok(!error.message.includes(secret))
    return true
  })
  const calls: string[] = []
  const keychain = new MacKeychain({ async run(_file, args) {
    calls.push(args[0]!)
    return { code: 0, stdout: args[0] === 'find-generic-password' ? 'wrong\n' : '', stderr: '' }
  } })
  await assert.rejects(keychain.store('dev', secret), /verification failed.*removed/)
  assert.deepEqual(calls, ['-i', 'find-generic-password', 'delete-generic-password'])
})

test('Keychain deletion ignores only missing item, reports permission failures', async () => {
  await new MacKeychain({ async run() { return { code: 44, stdout: '', stderr: '' } } }).remove('dev')
  await assert.rejects(new MacKeychain({ async run() { return { code: 1, stdout: '', stderr: 'not exposed' } } }).remove('dev'), /could not remove/)
})

test('real runner sends stdin via pipe without a shell or argv token', async () => {
  const token = 'token with "quotes" and $shell syntax'
  const result = await systemCommandRunner.run(process.execPath, ['-e', 'process.stdin.pipe(process.stdout)'], { stdin: token })
  assert.equal(result.code, 0)
  assert.equal(result.stdout, token)
})
