import { mkdirSync, readFileSync, writeFileSync, existsSync, chmodSync } from 'node:fs'
import path from 'node:path'
import { createInterface } from 'node:readline'
import { hashPassword, isRole, parseUsers, type UserRecord } from '../auth.js'

const usage = `Manage K8s UI console users.

Usage:
  users hash                                    Print a password hash for Helm values
  users add <username> <role> --file <path>     Add or update a user in a JSON users file
  users remove <username> --file <path>         Remove a user from a JSON users file

Roles: viewer, operator, admin. The password is read from the terminal
(hidden) or, when stdin is not a terminal, from the first line of stdin.`

async function readStdinLine(): Promise<string> {
  let text = ''
  for await (const chunk of process.stdin) text += chunk
  return text.split(/\r?\n/)[0] || ''
}

function promptHidden(question: string): Promise<string> {
  return new Promise((resolve) => {
    const terminal = createInterface({ input: process.stdin, output: process.stdout, terminal: true })
    process.stdout.write(question)
    ;(terminal as unknown as { _writeToOutput: (text: string) => void })._writeToOutput = () => {}
    terminal.question('', (answer) => {
      terminal.close()
      process.stdout.write('\n')
      resolve(answer)
    })
  })
}

async function readNewPassword(): Promise<string> {
  let password: string
  if (process.stdin.isTTY) {
    password = await promptHidden('Password: ')
    const confirmation = await promptHidden('Repeat password: ')
    if (password !== confirmation) throw new Error('Passwords do not match')
  } else {
    password = await readStdinLine()
  }
  if (password.length < 10) throw new Error('Use a password with at least 10 characters')
  return password
}

function fileArgument(args: string[]): string {
  const index = args.indexOf('--file')
  const file = index >= 0 ? args[index + 1] : undefined
  if (!file) throw new Error('--file <path> is required')
  args.splice(index, 2)
  return path.resolve(file)
}

function readUsersFile(file: string): UserRecord[] {
  if (!existsSync(file)) return []
  return parseUsers(JSON.parse(readFileSync(file, 'utf8')))
}

function writeUsersFile(file: string, users: UserRecord[]): void {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(users, null, 2) + '\n', { mode: 0o600 })
  chmodSync(file, 0o600)
}

async function main(args: string[]): Promise<void> {
  const command = args.shift()
  if (command === 'hash') {
    console.log(await hashPassword(await readNewPassword()))
    return
  }
  if (command === 'add') {
    const file = fileArgument(args)
    const [username, role] = args
    if (!username || !isRole(role)) throw new Error('Usage: users add <username> <viewer|operator|admin> --file <path>')
    const users = readUsersFile(file)
    const passwordHash = await hashPassword(await readNewPassword())
    const others = users.filter((user) => user.username.toLowerCase() !== username.toLowerCase())
    const next = parseUsers(others.concat({ username, role, passwordHash }))
    writeUsersFile(file, next)
    console.log((others.length === users.length ? 'Added ' : 'Updated ') + username + ' (' + role + ') in ' + file)
    return
  }
  if (command === 'remove') {
    const file = fileArgument(args)
    const [username] = args
    if (!username) throw new Error('Usage: users remove <username> --file <path>')
    const users = readUsersFile(file)
    const next = users.filter((user) => user.username.toLowerCase() !== username.toLowerCase())
    if (next.length === users.length) throw new Error(username + ' is not in ' + file)
    writeUsersFile(file, next)
    console.log('Removed ' + username + ' from ' + file)
    return
  }
  console.log(usage)
  if (command && command !== 'help' && command !== '--help') process.exitCode = 1
}

main(process.argv.slice(2)).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Unknown error')
  process.exitCode = 1
})
