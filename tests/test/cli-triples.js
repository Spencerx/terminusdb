const fs = require('fs/promises')
const path = require('path')
const exec = require('util').promisify(require('child_process').exec)
const { expect } = require('chai')
const { util } = require('../lib')

describe('cli-triples', function () {
  let dbPath
  let envs
  let terminusdbSh

  async function execEnv (command) {
    return exec(command, { env: envs })
  }

  before(async function () {
    this.timeout(200000)
    const testDir = path.join(__dirname, '..')
    terminusdbSh = path.join(testDir, 'terminusdb.sh')
    const rootDir = path.join(testDir, '..')
    const terminusdbExec = path.join(rootDir, 'terminusdb')

    dbPath = './storage/' + util.randomString()
    envs = {
      ...process.env,
      TERMINUSDB_SERVER_DB_PATH: dbPath,
      TERMINUSDB_EXEC_PATH: terminusdbExec,
    }
    {
      const r = await execEnv(`${terminusdbSh} store init --force`)
      expect(r.stdout).to.match(/^Successfully initialised database/)
    }
  })

  after(async function () {
    await fs.rm(dbPath, { recursive: true })
  })

  it('load non-existent file', async function () {
    const db = util.randomString()
    await execEnv(`${terminusdbSh} db create admin/${db}`)
    const r = await execEnv(`${terminusdbSh} triples load admin/${db}/local/branch/main/instance ${db} | true`)
    expect(r.stderr).to.match(new RegExp(`^Error: File not found: ${db}`))
    await execEnv(`${terminusdbSh} db delete admin/${db}`)
  })

  it('load trig file', async function () {
    const testDir = path.join(__dirname, '..')
    const trigFile = path.join(testDir, 'served', 'MW00KG01635.trig')
    const db = util.randomString()
    await execEnv(`${terminusdbSh} db create admin/${db} --schema=false`)
    const r = await execEnv(`${terminusdbSh} triples load admin/${db}/local/branch/main/instance ${trigFile}`)
    const escapedPath = trigFile.replace(/\\/g, '\\\\')
    expect(r.stdout).to.match(new RegExp(`Successfully inserted triples from '${escapedPath}'`))
    await execEnv(`${terminusdbSh} db delete admin/${db}`)
  })
})
